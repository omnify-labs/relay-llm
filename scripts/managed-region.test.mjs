import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

test("production Nginx denies managed routes by trusted country and preserves other routes", async () => {
  const source = await readFile(
    new URL("../deploy/nginx.conf", import.meta.url),
    "utf8",
  );
  assert.match(source, /\$dassi_geo_country source=\$remote_addr country_code/);
  assert.doesNotMatch(
    source,
    /real_ip_header|set_real_ip_from|http_x_(dassi_country|forwarded_for)/,
  );
  const firstServer = source.indexOf("server {");
  const httpsServer = source.indexOf("server {", firstServer + 1);
  assert.ok(httpsServer > firstServer);
  const lookup =
    "map $http_x_fixture_country $dassi_geo_country { default $http_x_fixture_country; }\n";
  const policy = source.slice(source.indexOf("geo $remote_addr"), firstServer);
  const config = (lookup + policy + source.slice(httpsServer))
    .replace("geo $remote_addr", "geo $http_x_fixture_peer")
    .replace("listen 443 ssl;", "listen 8080;")
    .replace(/^\s*ssl_certificate(?:_key)? .*;\n/gm, "")
    .replace("proxy_pass http://127.0.0.1:8080;", "return 204;");
  assert.doesNotMatch(config, /geoip2 |ssl_certificate|proxy_pass/);
  const folder = await mkdtemp(join(tmpdir(), "relay-region-"));
  const name = `relay-region-${process.pid}-${Date.now()}`;
  try {
    await writeFile(
      join(folder, "nginx.conf"),
      `events {}\nhttp { ${config} }`,
    );
    docker(
      "create",
      "--name",
      name,
      "--publish",
      "127.0.0.1::8080",
      "nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236",
    );
    docker("cp", join(folder, "nginx.conf"), `${name}:/etc/nginx/nginx.conf`);
    docker("start", name);
    const port = docker("port", name, "8080/tcp").split(":").at(-1);
    const url = `http://127.0.0.1:${port}`;
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(url);
        started = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(
      started,
      `Nginx must start with the production gate: ${docker("logs", name)}`,
    );
    for (const provider of ["openai", "anthropic", "google", "deepseek"]) {
      for (const country of ["CN", "", "XX", "ZZ", "T1", "US", "IN", "HK"]) {
        const response = await fetch(`${url}/v1/${provider}/test`, {
          method: "POST",
          headers: {
            "X-Fixture-Country": country,
            "CF-Connecting-IP": "8.8.8.8",
            "X-Dassi-Country": "US",
            "X-Forwarded-For": "8.8.8.8",
            "X-Dassi-Run-Id": "already-admitted",
          },
        });
        const blocked = ["", "XX", "ZZ", "T1"].includes(country);
        assert.equal(
          response.status,
          blocked ? 403 : 204,
          `${provider}:${country}`,
        );
        if (blocked) {
          assert.match(
            response.headers.get("Content-Type"),
            /application\/json/,
          );
          assert.equal(
            response.headers.get("Access-Control-Allow-Origin"),
            "*",
          );
          assert.match((await response.json()).error, /own API key/);
        }
      }
    }
    for (const route of [
      "/v1/openai/x%0ay",
      "/v1/google/x%0Ay",
      "/v1/openai",
      "/v1/OpenAI/test",
    ]) {
      const response = await fetch(url + route, {
        headers: { "X-Fixture-Country": "XX" },
      });
      assert.equal(response.status, 403, route);
    }
    for (const [peer, lookup, country, status] of [
      ["104.16.0.1", "US", "CN", 204],
      ["104.16.0.1", "US", "XX", 403],
      ["104.16.0.1", "CN", "US", 204],
      ["104.16.0.1", "US", "", 403],
      ["104.16.0.1", "US", "garbage", 403],
      ["2606:4700::1", "US", "XX", 403],
      ["1.2.3.4", "CN", "US", 403],
      ["1.2.3.4", "US", "CN", 403],
      ["1.2.3.4", "US", "US", 403],
      ["1.2.3.4", "US", "", 204],
    ]) {
      const response = await fetch(`${url}/v1/google/test`, {
        headers: {
          "X-Fixture-Peer": peer,
          "X-Fixture-Country": lookup,
          "CF-IPCountry": country,
        },
      });
      assert.equal(response.status, status, `proxy ${peer}:${country}`);
    }
    assert.equal(
      (
        await fetch(`${url}/v1/google/test`, {
          method: "OPTIONS",
          headers: { "X-Fixture-Country": "XX" },
        })
      ).status,
      204,
    );
    for (const route of ["/health", "/admin/budget", "/v1/runs/fixture/end"]) {
      assert.equal(
        (await fetch(url + route, { headers: { "X-Fixture-Country": "XX" } }))
          .status,
        204,
      );
    }
  } finally {
    try {
      docker("rm", "--force", name);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
});

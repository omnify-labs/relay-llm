# Contributing to RelayLLM

Thanks for your interest in contributing! RelayLLM is a small, focused project — contributions that keep it simple and reliable are welcome.

## Getting Started

```bash
git clone https://github.com/your-org/relay-llm.git
cd relay-llm
cp .env.example .env    # add your provider API keys + JWT secret
pnpm install
pnpm dev
```

## Development

```bash
pnpm dev          # run server in watch mode
pnpm typecheck    # strict TypeScript check
pnpm lint         # eslint
pnpm test         # unit tests (Vitest)
pnpm build        # production build
```

Before submitting a PR, make sure all four pass:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Make your changes — keep them focused and small
3. Add tests for new functionality
4. Run the full check suite (typecheck, lint, test, build)
5. Open a PR with a clear description of what and why

### What makes a good PR

- **One concern per PR** — don't mix bug fixes with features
- **Tests included** — at least 1 happy path, 1 edge case, 1 error case
- **No format translation** — this is the core rule. Never parse or modify request/response bodies in the proxy path

## Adding a Provider

Adding a new provider is a single entry in `src/proxy/providers.ts`. No translation logic needed — RelayLLM forwards everything as-is. See the existing providers for the pattern.

## Code Style

- TypeScript strict mode, no `any` without a comment explaining why
- `async/await` everywhere, no callbacks
- Files under 500 lines, functions under 40 lines
- JSDoc on exported functions
- Format with Prettier (2 spaces, 100 char width)

## Community

Join the [Discord](https://discord.gg/h82Y8rk4) to ask questions, discuss ideas, or get help.

## Reporting Issues

Open an issue with:
- What you expected
- What happened instead
- Steps to reproduce
- Node.js version and OS

## Security

If you find a security vulnerability, please email the maintainers privately instead of opening a public issue.

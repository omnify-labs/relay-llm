# @relay-llm/sdk

Route [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) models through the [Relay LLM proxy](https://github.com/your-org/relay-llm) for managed billing.

## Install

```bash
npm install @relay-llm/sdk @mariozechner/pi-ai
```

## Usage

```ts
import { relay } from '@relay-llm/sdk';
import { streamSimple } from '@mariozechner/pi-ai';

// Get a Relay-routed model from a model ID
const model = relay('claude-sonnet-4-5');

// Or reroute an existing pi-ai Model
import { getModel } from '@mariozechner/pi-ai';
const relayModel = relay(getModel('anthropic', 'claude-sonnet-4-5'));

// Stream with your JWT as the API key
const stream = streamSimple(model, context, { apiKey: jwt });
```

### Custom Relay URL

For self-hosted Relay instances:

```ts
const model = relay('gpt-4o', { relayUrl: 'https://my-relay.example.com' });
```

## API

### `relay(modelOrId, options?)`

Returns a pi-ai `Model` with `baseUrl` pointing to Relay.

- **`modelOrId`**: `string` (model ID like `'claude-sonnet-4-5'`) or existing pi-ai `Model`
- **`options.relayUrl`**: Override the default Relay URL

### `detectProvider(modelId)`

Detect the native provider from a model ID: `claude-*` -> `anthropic`, `gemini-*` -> `google`, else -> `openai`.

### Constants

- `RELAY_URL` — Default Relay proxy URL
- `RELAY_PROVIDERS` — Per-provider Relay endpoint URLs

## How It Works

Relay is a transparent HTTP proxy. It never parses or modifies request/response bodies. The SDK:

1. Detects the native provider from the model name (or Model's `api` field)
2. Gets the model from pi-ai's registry (using the native provider's SDK)
3. Overrides `baseUrl` to route through Relay

Your JWT is passed as the API key. Relay validates it, checks your budget, swaps in the real provider API key, and forwards the request.

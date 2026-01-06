# Food Manufacturing DAG App

A food manufacturing application built with Deno + Fresh that models production flow as a directed acyclic graph (DAG).

## Tech Stack

- **Runtime**: Deno
- **Framework**: Fresh
- **Persistence**: Deno KV
- **Language**: TypeScript

## Getting Started

```bash
# Start the development server
deno task start

# Build for production
deno task build

# Preview production build
deno task preview
```

## Project Structure

```
domain/          - Pure business logic (DAG, calculations, validations)
persistence/     - Deno KV operations and schemas
events/          - Typed event bus for island communication
islands/         - Fresh islands (UI components)
routes/          - Fresh routes and API endpoints
utils/           - Shared utilities and helpers
```


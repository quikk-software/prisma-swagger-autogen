# Prisma Swagger Autogen

Generate a **fully typed OpenAPI 3 specification directly from your Prisma models** and use it seamlessly with **`swagger-autogen`**.

This package allows you to treat **Prisma as the single source of truth** for your API data structures and automatically expose those structures as **correct Swagger schemas**, without manually duplicating DTOs or schema definitions.

---

## ✨ What This Tool Is For

The main goal of this package is:

> **To automatically generate correct Swagger/OpenAPI schemas based on your Prisma models, so that Swagger, Swagger UI, and generated API clients all share the same types.**

Instead of:
- manually writing OpenAPI schemas
- duplicating DTOs
- maintaining separate validation and documentation layers

you can rely on **Prisma’s type system** and generate everything from there.

---

## 🔁 How It Fits Into Your Tooling

This tool is designed to work **together with `swagger-autogen`**, not replace it.

### The workflow looks like this:

1. **Prisma models** define your domain
2. This package:
    - reads Prisma DMMF
    - generates OpenAPI schemas (`components.schemas`)
    - builds a ready-to-use `swagger.config.js`
3. **`swagger-autogen`**:
    - scans your controllers
    - uses the generated config
    - produces a complete `openapi.json`
4. Optional:
    - generate a TypeScript client
    - generate SDKs
    - use Swagger UI

✔ One source of truth  
✔ No duplicated schemas  
✔ No mismatched DTOs

---

## 🚀 Why This Matters

Without this approach, teams often end up with:

- Prisma models
- Request/Response DTOs
- Swagger schemas
- Client-side models

…all slightly different.

This tool ensures that:

- **Prisma → Swagger is automatic**
- **Swagger schemas are structurally correct**
- **Swagger-generated TypeScript clients contain real data shapes**
- **Request bodies and responses are usable out of the box**

---

## ❌ What This Tool Does *Not* Do

- It does **not** replace `swagger-autogen`
- It does **not** scan controllers itself
- It does **not** generate routes

Instead, it **prepares the Swagger configuration** so that `swagger-autogen` can do its job properly.

---

## 📦 Installation

```bash
npm install -D prisma-swagger-autogen
```

---

## 🛠 Usage

1. Generate swagger.config.js from Prisma

``` 
npx prisma-swagger-autogen
```

This will generate a swagger.config.js file in your project root.

The file already contains:

- components.schemas derived from Prisma
- security schemes
- server configuration
- controller file paths

2. Run swagger-autogen
 
```
node swagger.config.js
```

This generates:

`src/web/api/openapi.json`

3. (Optional) Generate a TypeScript API client
   
```
npx swagger-typescript-api \
   -p src/web/api/openapi.json \
   -o src/web/api/client \
   -n api.ts
```


The resulting TypeScript types now match your Prisma models:

```typescript
export interface GetUserResponse {
    userId: string;
    name: string;
    birthday?: string;
}
```


No OpenAPI schema metadata. No `type?: string`.

---

## 🧠 Design Philosophy

### Prisma as the Source of Truth

Prisma already defines:

- field types
- nullability
- relations
- lists
- enums

This tool leverages that information to generate correct OpenAPI schemas, instead of redefining them manually.

---

### Swagger-Autogen Friendly

The generated `swagger.config.js` is intentionally designed to:

- be plain JavaScript
- be executable by Node.js
- be consumed directly by swagger-autogen

No runtime magic, no custom Swagger parser.

---

## ⚙️ Default Configuration

```typescript
{
    controllersGlob: "./src/web/api/controllers/**/*.ts",
    openapiOut: "./src/web/api/openapi.json",
    serviceTitle: "My Service",
    serverUrl: "http://localhost:3000",
    omitFieldsInWriteDtos: ["id", "createdAt", "updatedAt"]
}
```

---

## 🧩 Requirements

- Node.js ≥ 18
- Prisma Client (@prisma/client)
- swagger-autogen

Prisma schema already generated (prisma generate)

---

## ⚠️ Common Pitfalls
1. Missing request bodies in Swagger UI

Controllers still need proper swagger-autogen annotations:

```typescript
/* #swagger.requestBody = {
    required: true,
        content: {
            "application/json": {
                schema: { $ref: "#/components/schemas/PostUserRequest" }
            }
        }
    } */
```


This tool provides the schemas — the controller annotations wire them up.

2. Primitive types leaking as OpenAPI schema objects

If your generated TypeScript client contains types like this:

```typescript
name?: {
    type?: string;
    format?: string;
};
```


then your OpenAPI schemas are being interpreted as schema definitions instead of data shapes.

This usually happens when:

- OpenAPI schemas expose type, properties, items, etc. as part of the object
- TypeScript generators mirror those schema internals instead of resolving them

✔ This tool explicitly generates schemas in a way that swagger-autogen + swagger-typescript-api interpret as real DTOs, resulting in:

`name?: string;`

If you still see `type?: string` fields in your client:

- ensure the OpenAPI spec was generated using the swagger.config.js from this tool
- ensure you regenerated the client after regenerating openapi.json

---

## 📄 License

MIT

---

## 🤝 Contributing

Contributions are welcome, especially for:

- Prisma edge cases
- Advanced relation handling
- Custom schema naming strategies

---

## ⭐ Summary

Prisma Swagger Autogen enables you to:

- define your API models once (in Prisma)
- automatically expose them in Swagger
- generate clean, usable API clients
- keep documentation, backend, and frontend in sync
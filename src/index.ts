import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { execSync } from 'node:child_process';

type OpenApiSchema =
    | {
    type?: string | string[];
    format?: string;
    required?: string[];
    properties?: Record<string, OpenApiSchema>;
    items?: OpenApiSchema;
    enum?: string[];
    example?: any;
    $ref?: string;
    allOf?: OpenApiSchema[];
}
    | Record<string, any>;

type DmmfField = {
    name: string;
    kind: 'scalar' | 'enum' | 'object';
    type: string;
    isRequired: boolean;
    isList: boolean;
};

type DmmfModel = {
    name: string;
    fields: DmmfField[];
};

type DmmfEnum = {
    name: string;
    values: Array<{ name: string }>;
};

type DmmfDatamodel = {
    models: DmmfModel[];
    enums: DmmfEnum[];
};

type Dmmf = {
    datamodel: DmmfDatamodel;
};

const CONFIG = {
    projectRoot: process.cwd(),
    controllersGlob: './src/web/api/controllers/**/*.ts',
    outFile: './swagger.config.js',
    openapiOut: './src/web/api/openapi.json',
    serviceTitle: 'Prescription Service',
    serverUrl: 'http://localhost:3008',
    securitySchemeName: 'keycloakOAuth',
    oauth: {
        tokenUrl: 'http://auth.localhost/realms/haemo/protocol/openid-connect/token',
        refreshUrl: 'http://auth.localhost/realms/haemo/protocol/openid-connect/refresh',
        scopes: { openid: 'openid scope' as const },
    },
    omitFieldsInWriteDtos: new Set(['id', 'createdAt', 'updatedAt', 'v']),
};

function ensurePosix(p: string) {
    return p.split(path.sep).join(path.posix.sep);
}

function pluralize(name: string) {
    if (name.endsWith('s')) return `${name}es`;
    return `${name}s`;
}

function scalarToSchema(scalar: string): OpenApiSchema {
    switch (scalar) {
        case 'String':
            return { type: 'string' };
        case 'Boolean':
            return { type: 'boolean' };
        case 'Int':
            return { type: 'integer' };
        case 'BigInt':
            return { type: 'integer', format: 'int64' };
        case 'Float':
            return { type: 'number' };
        case 'Decimal':
            return { type: 'number' };
        case 'DateTime':
            return { type: 'string', format: 'date-time' };
        case 'Json':
            return { type: 'object' };
        case 'Bytes':
            return { type: 'string', format: 'byte' };
        default:
            return { type: 'string' };
    }
}

function fieldSchema(field: DmmfField, getRefName: (model: string) => string): OpenApiSchema {
    if (field.kind === 'scalar') {
        const base = scalarToSchema(field.type);
        if (field.isList) return { type: 'array', items: base };
        return base;
    }

    if (field.kind === 'enum') {
        const base: OpenApiSchema = { $ref: `#/components/schemas/${field.type}` };
        if (field.isList) return { type: 'array', items: base };
        return base;
    }

    if (field.kind === 'object') {
        const ref: OpenApiSchema = { $ref: `#/components/schemas/${getRefName(String(field.type))}` };
        if (field.isList) return { type: 'array', items: ref };
        return ref;
    }

    return { type: 'object' };
}

function modelToGetSchema(model: DmmfModel, getRefName: (model: string) => string): OpenApiSchema {
    const properties: Record<string, OpenApiSchema> = {};
    const required: string[] = [];

    for (const f of model.fields) {
        properties[f.name] = fieldSchema(f, getRefName);
        if (f.isRequired) required.push(f.name);
    }

    const schema: OpenApiSchema = { type: 'object', properties };
    if (required.length) schema.required = required;

    return schema;
}

function stripWriteFields(model: DmmfModel, getSchema: OpenApiSchema, omit: Set<string>): OpenApiSchema {
    const schema = JSON.parse(JSON.stringify(getSchema)) as OpenApiSchema;
    if (!schema.properties) return schema;

    const relationFieldNames = new Set(model.fields.filter((f) => f.kind === 'object').map((f) => f.name));

    for (const key of Object.keys(schema.properties)) {
        if (omit.has(key) || relationFieldNames.has(key)) delete schema.properties[key];
    }

    if (Array.isArray(schema.required)) {
        schema.required = schema.required.filter((k) => !omit.has(k) && !relationFieldNames.has(k));
        if (schema.required.length === 0) delete schema.required;
    }

    return schema;
}

function makeAllOptional(schema: OpenApiSchema): OpenApiSchema {
    const s = JSON.parse(JSON.stringify(schema)) as OpenApiSchema;
    delete s.required;
    return s;
}

function listResponseSchema(itemRef: string): OpenApiSchema {
    return {
        type: 'object',
        properties: {
            count: { type: 'number', example: 3 },
            hasPreviousPage: { type: 'boolean', example: false },
            hasNextPage: { type: 'boolean', example: true },
            pageNumber: { type: 'number', example: 1 },
            pageSize: { type: 'number', example: 10 },
            totalPages: { type: 'number', example: 1 },
            items: { type: 'array', items: { $ref: itemRef } },
        },
        required: ['count', 'hasPreviousPage', 'hasNextPage', 'pageNumber', 'pageSize', 'totalPages', 'items'],
    };
}

function exampleForScalarType(type: string, format?: string) {
    if (type === 'string' && format === 'date-time') return new Date(0).toISOString();
    switch (type) {
        case 'string':
            return 'string';
        case 'integer':
            return 0;
        case 'number':
            return 0;
        case 'boolean':
            return true;
        case 'object':
            return {};
        default:
            return null;
    }
}

function buildExampleFromSchema(schema: OpenApiSchema, components: Record<string, OpenApiSchema>, depth = 0): any {
    if (depth > 2) return undefined;

    if ((schema as any).$ref) {
        const name = String((schema as any).$ref).split('/').pop() || '';
        const target = (components as any)[name] as OpenApiSchema | undefined;
        if (!target) return undefined;
        return buildExampleFromSchema(target, components, depth + 1);
    }

    if (Array.isArray((schema as any).allOf) && (schema as any).allOf.length) {
        const merged: any = {};
        for (const part of (schema as any).allOf as OpenApiSchema[]) {
            const ex = buildExampleFromSchema(part, components, depth + 1);
            if (ex && typeof ex === 'object' && !Array.isArray(ex)) Object.assign(merged, ex);
        }
        return Object.keys(merged).length ? merged : undefined;
    }

    if ((schema as any).type === 'array' && (schema as any).items) {
        const item = buildExampleFromSchema((schema as any).items as OpenApiSchema, components, depth + 1);
        return item === undefined ? [] : [item];
    }

    if ((schema as any).type === 'object' && (schema as any).properties) {
        const obj: any = {};
        for (const [k, v] of Object.entries((schema as any).properties as Record<string, OpenApiSchema>)) {
            const ex = buildExampleFromSchema(v, components, depth + 1);
            if (ex !== undefined) obj[k] = ex;
        }
        return obj;
    }

    if (Array.isArray((schema as any).enum) && (schema as any).enum.length) return (schema as any).enum[0];

    if (typeof (schema as any).type === 'string') return exampleForScalarType((schema as any).type, (schema as any).format);

    return undefined;
}

function attachExample(schema: OpenApiSchema, components: Record<string, OpenApiSchema>): OpenApiSchema {
    const s = JSON.parse(JSON.stringify(schema)) as OpenApiSchema;
    if ((s as any).example === undefined) {
        const ex = buildExampleFromSchema(s, components);
        if (ex !== undefined) (s as any).example = ex;
    }
    return s;
}

async function loadDmmfFromProject(): Promise<Dmmf> {
    const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
    if (!fs.existsSync(schemaPath)) {
        throw new Error(`Prisma schema not found at: ${schemaPath}`);
    }

    const datamodel = fs.readFileSync(schemaPath, 'utf8');

    let runtime: any;
    try {
        runtime = await import('@prisma/client/runtime');
    } catch {
        try {
            runtime = await import('@prisma/client/runtime/library');
        } catch {
            throw new Error(
                `Unable to import Prisma runtime. Please ensure @prisma/client is installed and generated.\nTried: '@prisma/client/runtime' and '@prisma/client/runtime/library'`,
            );
        }
    }

    const getDMMF = runtime.getDMMF as ((args: { datamodel: string }) => Promise<any>) | undefined;
    if (!getDMMF) {
        throw new Error(
            `Prisma runtime does not expose getDMMF(). Your Prisma version may be incompatible.\nTry updating prisma + @prisma/client.`,
        );
    }

    const dmmf = (await getDMMF({ datamodel })) as Dmmf;
    if (!dmmf?.datamodel?.models) {
        throw new Error(`Failed to load Prisma DMMF. Prisma returned an unexpected structure.`);
    }

    return dmmf;
}

function buildSchemasFromDmmf(dmmf: Dmmf) {
    const schemas: Record<string, OpenApiSchema> = {};
    const getRefName = (modelName: string) => `Get${modelName}Response`;

    for (const e of dmmf.datamodel.enums) {
        schemas[e.name] = { type: 'string', enum: e.values.map((v) => v.name) };
    }

    for (const model of dmmf.datamodel.models) {
        const getName = `Get${model.name}Response`;
        const postName = `Post${model.name}Request`;
        const putName = `Put${model.name}Request`;
        const listName = `List${pluralize(model.name)}Response`;

        const getSchema = modelToGetSchema(model, getRefName);
        const postSchema = stripWriteFields(model, getSchema, CONFIG.omitFieldsInWriteDtos);
        const putSchema = makeAllOptional(postSchema);

        schemas[getName] = getSchema;
        schemas[postName] = postSchema;
        schemas[putName] = putSchema;
        schemas[listName] = listResponseSchema(`#/components/schemas/${getName}`);
    }

    schemas['ExceptionResponse'] = {
        type: 'object',
        properties: {
            detail: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
            status: { type: 'number' },
            title: { type: 'string' },
            type: { type: 'string' },
        },
        required: ['status', 'title', 'type'],
    };

    schemas['BadRequestResponse'] = {
        allOf: [{ $ref: '#/components/schemas/ExceptionResponse' }],
        example: {
            status: 400,
            title: 'The request was invalid',
            type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
        },
    };

    schemas['NotFoundResponse'] = {
        allOf: [{ $ref: '#/components/schemas/ExceptionResponse' }],
        example: {
            status: 404,
            title: 'The specified resource was not found',
            type: 'https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.4',
        },
    };

    schemas['InternalErrorResponse'] = {
        allOf: [{ $ref: '#/components/schemas/ExceptionResponse' }],
        example: {
            status: 500,
            title: 'An error occurred while processing your request',
            type: 'https://tools.ietf.org/html/rfc7231#section-6.6.1',
        },
    };

    for (const name of Object.keys(schemas)) {
        if (name.startsWith('Post') && name.endsWith('Request')) schemas[name] = attachExample(schemas[name], schemas);
        if (name.startsWith('Put') && name.endsWith('Request')) schemas[name] = attachExample(schemas[name], schemas);
    }

    return schemas;
}

function generateSwaggerConfigJs(schemas: Record<string, OpenApiSchema>) {
    const routes = globSync(CONFIG.controllersGlob, { nodir: true }).map((p) => ensurePosix(p));

    const docs = {
        info: { title: CONFIG.serviceTitle },
        servers: [{ url: CONFIG.serverUrl }],
        components: {
            schemas,
            securitySchemes: {
                [CONFIG.securitySchemeName]: {
                    type: 'oauth2',
                    description: 'This API uses OAuth2 with the password flow.',
                    flows: {
                        password: {
                            tokenUrl: CONFIG.oauth.tokenUrl,
                            refreshUrl: CONFIG.oauth.refreshUrl,
                            scopes: CONFIG.oauth.scopes,
                        },
                    },
                },
            },
        },
        security: [{ [CONFIG.securitySchemeName]: ['openid'] }],
    };

    const fileContent = `const swaggerAutogen = require('swagger-autogen')();
const fs = require('fs');
const path = require('node:path');

function isPlainObject(v){return v!==null && typeof v==='object' && !Array.isArray(v);}

function normalizeSchema(schema){
	if(!isPlainObject(schema)) return schema;
	if(schema.$ref) return schema;

	if(isPlainObject(schema.type) && typeof schema.type.example === 'string') schema.type = schema.type.example;
	if(isPlainObject(schema.format) && typeof schema.format.example === 'string') schema.format = schema.format.example;
	if(isPlainObject(schema.required) && Array.isArray(schema.required.example)) schema.required = schema.required.example;
	if(isPlainObject(schema.enum) && Array.isArray(schema.enum.example)) schema.enum = schema.enum.example;

	if(Array.isArray(schema.allOf)) schema.allOf = schema.allOf.map(normalizeSchema);
	if(isPlainObject(schema.items)) schema.items = normalizeSchema(schema.items);
	if(isPlainObject(schema.additionalProperties)) schema.additionalProperties = normalizeSchema(schema.additionalProperties);

	if(isPlainObject(schema.properties)){
		for(const k of Object.keys(schema.properties)){
			schema.properties[k] = normalizeSchema(schema.properties[k]);
		}
	}

	return schema;
}

function fixOpenApiFile(openapiPath){
	const abs = path.resolve(process.cwd(), openapiPath);
	if(!fs.existsSync(abs)) return;
	const doc = JSON.parse(fs.readFileSync(abs,'utf8'));

	if(doc && doc.components && isPlainObject(doc.components.schemas)){
		for(const name of Object.keys(doc.components.schemas)){
			doc.components.schemas[name] = normalizeSchema(doc.components.schemas[name]);
		}
	}

	fs.writeFileSync(abs, JSON.stringify(doc,null,2),'utf8');
}

const docs = ${JSON.stringify(docs, null, 2)};
const routes = ${JSON.stringify(routes, null, 2)};

swaggerAutogen('${ensurePosix(CONFIG.openapiOut)}', routes, docs)
	.then(() => fixOpenApiFile('${ensurePosix(CONFIG.openapiOut)}'))
	.catch((e) => { console.error(e); process.exitCode = 1; });
`;

    const outPath = path.resolve(CONFIG.projectRoot, CONFIG.outFile);
    fs.writeFileSync(outPath, fileContent, 'utf8');
}

export async function run(_args: string[]) {
    const dmmf = await loadDmmfFromProject();
    const schemas = buildSchemasFromDmmf(dmmf);
    generateSwaggerConfigJs(schemas);
}

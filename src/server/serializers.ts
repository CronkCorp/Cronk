import { SerializerSelector } from "@fastify/fast-json-stringify-compiler";

type SerializerFactory = ReturnType<typeof SerializerSelector>;
type Serializer = ReturnType<ReturnType<SerializerFactory>>;

const build = SerializerSelector();
/** Compiled serializers by their shared schemas and options, then by their own schema. */
const compiled = new Map<string, Map<string, Serializer>>();

/**
 * Fastify's response serializer factory, remembering every serializer it compiles for the life of the process.
 * Compiling them is most of the work of starting the app; a second app built from the same schemas (each test
 * builds its own) reuses them instead. A serializer depends only on its schema, the shared schemas it refers to
 * and the options, so those are the key.
 */
export const cachedSerializers: SerializerFactory = (externalSchemas, serializerOpts) => {
  const compile = build(externalSchemas, serializerOpts);
  const shared = JSON.stringify([externalSchemas, serializerOpts]);
  let bySchema = compiled.get(shared);
  if (!bySchema) compiled.set(shared, (bySchema = new Map()));
  const cache = bySchema;
  return (route) => {
    const key = JSON.stringify(route.schema);
    let serializer = cache.get(key);
    if (!serializer) {
      serializer = compile(route);
      cache.set(key, serializer);
    }
    return serializer;
  };
};

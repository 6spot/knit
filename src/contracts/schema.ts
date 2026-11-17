import { compile, type JsonSchema, type Static, type ValidationError } from "@earendil-works/pi-schema";

type SchemaValidator = ReturnType<typeof compile>;

/** 同一 schema 对象只编译一次；动态传入的 schema 也走同一入口。 */
const validators = new WeakMap<object, SchemaValidator>();

function validatorFor(schema: JsonSchema): SchemaValidator {
  if (typeof schema === "boolean") return compile(schema);
  const existing = validators.get(schema);
  if (existing !== undefined) return existing;
  const created = compile(schema);
  validators.set(schema, created);
  return created;
}

/** JSON Schema 接受性校验；不改变传入值。 */
export function checkSchema<S extends JsonSchema>(schema: S, value: unknown): value is Static<S> {
  return validatorFor(schema).check(value);
}

/** 校验失败原因；路径为 JSON Pointer（根为空串），仅用于诊断。 */
export function schemaErrors(schema: JsonSchema, value: unknown): readonly ValidationError[] {
  return validatorFor(schema).errors(value);
}

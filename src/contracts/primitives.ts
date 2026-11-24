import { createHash } from "node:crypto";
import { compile, type JsonSchema, type Static, type ValidationError } from "@earendil-works/pi-schema";

/** 字节指纹：sha256 hex；用于原子写预期版本与快照对照。 */
export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}

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

/** 结构不对的地方，一处一句话，句子里带着出问题的字段。 */
export function schemaProblems(schema: JsonSchema, value: unknown): string[] {
  return schemaErrors(schema, value).map((error) => {
    const field = error.path.slice(1);
    if (field === "") return `应当是一组字段：${error.message}`;
    if (error.keyword === "required") return `缺少字段 ${field}`;
    if (error.keyword === "additionalProperties") return `多了字段 ${field}`;
    return `字段 ${field} 的值不对：${error.message}`;
  });
}

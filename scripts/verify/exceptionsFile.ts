import { join } from "node:path";
import { parseExceptions, type VerifyException } from "../../app/verify/exceptions";
import { UsageError } from "./cli";

export const EXCEPTIONS_FILE = "verify-exceptions.json";

export async function readExceptions(dir: string): Promise<VerifyException[]> {
  const file = Bun.file(join(dir, EXCEPTIONS_FILE));
  if (!(await file.exists())) return [];
  try {
    return parseExceptions(JSON.parse(await file.text()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${join(dir, EXCEPTIONS_FILE)} does not load: ${message}`);
  }
}

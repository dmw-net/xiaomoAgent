import { getJson } from "./client";
import type { UserDiagnostics } from "../types";

/** 只读运行检查。与 DEV_MODE 无关，返回的是面向用户的安全摘要。 */
export function run(): Promise<UserDiagnostics> {
  return getJson<UserDiagnostics>("/api/diagnostics");
}

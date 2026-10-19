import { getJson } from "./client";
import type { UsageStats } from "../types";

export function fetchUsageStats(): Promise<UsageStats> {
  return getJson("/api/usage/stats");
}

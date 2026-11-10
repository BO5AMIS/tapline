import { readFileSync } from "node:fs";
import { z } from "zod";

export const configSchema = z.object({
  tool: z.string().min(1),
  version: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  phone: z.string().min(1),
  ios: z.string().min(1),
  link: z.enum(["good", "3g"]),
  labUrl: z.string().min(1).optional(),
});

export type BenchConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): BenchConfig {
  const r = configSchema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config: ${msg}`);
  }
  return r.data;
}

export function loadConfig(path: string): BenchConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseConfig(raw);
}

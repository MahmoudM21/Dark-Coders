import { fail, type Envelope } from "./contracts.ts";

type RpcOptions = {
  timeoutMs?: number;
  requestId?: string;
};

function asMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error";
}

export async function callRpc(
  fn: string,
  args: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<Envelope> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const timeoutMs = options.timeoutMs ?? 8000;
  const requestId = options.requestId ?? "";
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await (supabaseAdmin as unknown as {
      rpc: (
        rpcName: string,
        rpcArgs: Record<string, unknown>,
        opts?: { signal?: AbortSignal },
      ) => Promise<{ data: unknown; error: { code?: string | null; message?: string | null; details?: string | null } | null }>;
    }).rpc(fn, args, { signal: controller.signal });

    if (result.error) {
      const latency = Date.now() - started;
      console.error(`[clinic.rpc] fn=${fn} request_id=${requestId} latency_ms=${latency} error=${result.error.code ?? "unknown"}`);
      return fail("DB_ERROR", result.error.message ?? "Database request failed", {
        db_code: result.error.code ?? undefined,
        details: result.error.details ?? undefined,
      });
    }

    const latency = Date.now() - started;
    console.error(`[clinic.rpc] fn=${fn} request_id=${requestId} latency_ms=${latency}`);
    // The SQL functions return the {ok,data}/{ok,error} envelope as jsonb; PostgREST hands it back untyped.
    return (result.data as Envelope | null | undefined) ?? fail("INTERNAL", `${fn} returned no data`);
  } catch (error) {
    const latency = Date.now() - started;
    const message = asMessage(error);
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      console.error(`[clinic.rpc] fn=${fn} request_id=${requestId} latency_ms=${latency} timeout=true`);
      return fail("UPSTREAM_TIMEOUT", `RPC timed out after ${timeoutMs}ms`);
    }
    console.error(`[clinic.rpc] fn=${fn} request_id=${requestId} latency_ms=${latency} thrown=true`);
    return fail("DB_ERROR", message);
  } finally {
    clearTimeout(timeout);
  }
}

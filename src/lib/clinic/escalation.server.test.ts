import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escalate } from "./escalation.server.ts";

describe("escalate", () => {
  it("strips contact details and reports delivery failure when webhook missing", async () => {
    const result = await escalate(
      "11111111-1111-4111-8111-111111111111",
      { severity: "handoff", reason: "test", summary: "caller asked for human" },
      {
        callRpcFn: async (fn: string) => {
          if (fn === "clinic_escalate") {
            return {
              ok: true,
              data: {
                escalation_id: "e-1",
                route: "notify_contact",
                within_hours: false,
                contact: { phone: "+201000000000" },
                public: { emergency_services_number: "123", clinic_phone: "+202555" },
              },
            };
          }
          return { ok: true, data: { status: "delivery_failed" } };
        },
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.delivery_status, "delivery_failed");
    assert.equal("contact" in (result.data as Record<string, unknown>), false);
    assert.equal(result.data.emergency_services_number, "123");
  });

  it("reports notified when webhook succeeds", async () => {
    const previous = process.env["ESCALATION_WEBHOOK_URL"];
    process.env["ESCALATION_WEBHOOK_URL"] = "https://example.invalid/escalate";
    try {
      const result = await escalate(
        "11111111-1111-4111-8111-111111111111",
        { severity: "urgent", reason: "x", summary: "y" },
        {
          callRpcFn: async (fn: string) => {
            if (fn === "clinic_escalate") {
              return {
                ok: true,
                data: {
                  escalation_id: "e-2",
                  route: "notify_contact",
                  within_hours: true,
                  contact: { email: "staff@example.invalid" },
                  public: { emergency_services_number: "123", clinic_phone: "+202555" },
                },
              };
            }
            return { ok: true, data: { status: "notified" } };
          },
          fetchImpl: async () => new Response("ok", { status: 200 }),
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.data.delivery_status, "notified");
    } finally {
      if (previous === undefined) delete process.env["ESCALATION_WEBHOOK_URL"];
      else process.env["ESCALATION_WEBHOOK_URL"] = previous;
    }
  });
});

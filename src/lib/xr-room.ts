import { paginate, NAV_LABEL, type Screen } from "./voice/screen.ts";

export type RoomMessage = { id: string; role: "user" | "assistant"; text: string; screen?: Screen };
export type RoomPage = { messageId: string; role: RoomMessage["role"]; text: string; part: number; total: number };

/** Keep the complete conversation readable in a stable-size spatial panel. */
export function roomPages(messages: RoomMessage[]): RoomPage[] {
  return messages.flatMap((message) => {
    const parts = paginate(message.text, 440);
    return parts.map((text, part) => ({ messageId: message.id, role: message.role, text, part, total: parts.length }));
  });
}

export function roomChoices(messages: RoomMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.screen) return [];
  return [
    ...last.screen.choices.map((choice) => ({ label: choice.label, value: choice.value })),
    ...last.screen.navigation.map((nav) => ({ label: NAV_LABEL[nav], value: nav })),
  ].slice(0, 4);
}
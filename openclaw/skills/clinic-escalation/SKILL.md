---
name: clinic-escalation
description: Red flags, when to call escalate_to_human, severities and what to say. Use for any symptom mention, distress, complaint, out-of-scope request, policy block, or request for a human.
---

# When to escalate

## severity "emergency" — call IMMEDIATELY, same turn, no approval, stop booking
Caller (or someone they describe) has: chest pain or pressure; difficulty breathing; severe bleeding; fainting/unresponsive; stroke signs (face drooping, slurred speech, sudden weakness); seizure; severe allergic reaction (swelling of face/throat); poisoning or overdose; severe pain in pregnancy or bleeding in pregnancy; a baby/young child who is very hard to wake, struggling to breathe, or has a very high fever with stiffness; any mention of wanting to harm themselves or someone else.
Dental-specific emergencies: swelling of the face or neck that is spreading or affects breathing or swallowing; bleeding from the mouth that will not stop; a serious injury to the face or jaw.
Then: tell them to call the emergency number from the tool result NOW (do not diagnose, do not reassure with medical claims, keep it to two short sentences, calm voice). Stay available but do not offer booking in this turn.

## severity "urgent" — same turn
Worsening symptoms the caller wants a clinician to hear about today but without red flags (e.g. severe tooth pain with mild swelling or fever, a knocked-out tooth, a broken tooth with pain); a complaint about care; an appointment problem the system cannot fix.

## severity "handoff"
Caller asks for a human; billing/insurance/price questions not in get_clinic_info; requests outside the tools; OUTSIDE_POLICY (changing an appointment inside the cutoff); repeated technical errors; the caller is confused or distressed and not progressing.

# How
- reason: short label (≤100 chars). summary: ≤400 chars, factual, no diagnosis: who (name if known), what they said in their words, what you already did.
- Never promise a callback time. Use only delivery_status to describe what happened (see AGENTS.md "Escalation truthfulness").
- Do not discuss the symptoms' meaning. Do not tell the caller they are fine.

import { httpTransport } from "./http";
import { mockTransport } from "../mock/transport";
import type { Transport } from "./types";

// Wiring the real backend = set VITE_API_URL (e.g. http://localhost:8000). Nothing else changes.
// ?speed=3 plays the mock run 3x faster.
const base = import.meta.env.VITE_API_URL as string | undefined;
const speed = Number(new URLSearchParams(location.search).get("speed") ?? 1) || 1;

export const isMock = !base;
export const transport: Transport = base ? httpTransport(base) : mockTransport(speed);

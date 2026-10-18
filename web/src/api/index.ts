import { httpTransport } from "./http";
import { mockTransport } from "../mock/transport";
import type { Transport } from "./types";

// ?mode=mock            in-browser mock scenarios (playground)
// ?run=<id>             open a run from the backend (live or recorded); ?speed=N replays faster
// (default)             backend: ask a question to start a live run, or pick a recorded run
// VITE_API_URL          point at a backend on another origin; by default the same origin is used
//                       (Vite dev plugin / proxy in dev, FastAPI serving web/dist in production)
const params = new URLSearchParams(location.search);
const speed = Number(params.get("speed") ?? 0) || undefined;

export const isMock = params.get("mode") === "mock";
export const initialRun = params.get("run");
export const transport: Transport = isMock
  ? mockTransport(speed ?? 1)
  : httpTransport((import.meta.env.VITE_API_URL as string | undefined) ?? "", { speed: initialRun ? (speed ?? 4) : undefined });

/** Recorded / live runs are always listed from the backend side, also while in mock mode. */
export const backend: Transport = isMock ? httpTransport((import.meta.env.VITE_API_URL as string | undefined) ?? "") : transport;

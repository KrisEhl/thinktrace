import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.DEV) import("./state/store").then((m) => ((window as unknown as { __gb: unknown }).__gb = m.useStore));

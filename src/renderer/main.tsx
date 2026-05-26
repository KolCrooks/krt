import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);

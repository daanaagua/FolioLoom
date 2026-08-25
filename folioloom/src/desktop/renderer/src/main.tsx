import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("FolioLoom renderer root is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

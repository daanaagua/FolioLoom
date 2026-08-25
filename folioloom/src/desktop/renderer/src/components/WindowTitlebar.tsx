import type { JSX } from "react";

export function WindowTitlebar(): JSX.Element {
  return (
    <header className="window-titlebar" aria-label="应用标题栏">
      <span className="window-titlebar-label">FolioLoom · 翻译中</span>
    </header>
  );
}

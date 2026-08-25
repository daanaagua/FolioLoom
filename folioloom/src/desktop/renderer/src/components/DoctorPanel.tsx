import type { JSX } from "react";

import type { DesktopDoctorReport, DesktopResult } from "../../../contracts.js";

interface DoctorPanelProps {
  result: DesktopResult<DesktopDoctorReport> | undefined;
  busy: boolean;
  onRun(): void;
  onChooseProject(): void;
}

/** A compatibility panel for future read-only checks. */
export function DoctorPanel({ result, busy, onRun }: DoctorPanelProps): JSX.Element {
  const copy = result === undefined
    ? "书稿准备完成后，可以在这里查看检查结果。"
    : result.ok
      ? "检查已完成。"
      : "检查没有完成，请重新选择书稿后再试。";
  return (
    <section className="operation-error">
      <p>{copy}</p>
      <button className="quiet-button" type="button" onClick={onRun} disabled={busy}>重新检查</button>
    </section>
  );
}

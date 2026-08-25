import type { JSX } from "react";

import type {
  DesktopSourceEncoding,
  DesktopSourceEncodingRequired,
} from "../../../contracts.js";

interface EncodingChooserProps {
  pending: DesktopSourceEncodingRequired;
  busy: boolean;
  onConfirm(encoding: DesktopSourceEncoding): Promise<void>;
  onChooseAnother(): Promise<void>;
}

const ENCODING_LABELS: Readonly<Record<DesktopSourceEncoding, string>> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "utf-32le": "UTF-32 LE",
  "utf-32be": "UTF-32 BE",
  shift_jis: "Shift-JIS（日文）",
  "euc-jp": "EUC-JP（日文）",
  "euc-kr": "EUC-KR（韩文）",
  "windows-949": "Windows-949 / CP949（韩文）",
  "windows-1252": "Windows-1252（西欧文字）",
};

export function EncodingChooser({
  pending,
  busy,
  onConfirm,
  onChooseAnother,
}: EncodingChooserProps): JSX.Element {
  return (
    <section className="encoding-chooser" aria-labelledby="encoding-choice-title">
      <p className="eyebrow">书稿编码</p>
      <h2 id="encoding-choice-title">请选择文字编码</h2>
      <p className="section-copy">
        <strong>{pending.fileName}</strong>
        的两种读取方式都合理，请选择这本书实际使用的编码。
      </p>
      <div className="encoding-options">
        {pending.encodings.map((encoding) => (
          <button
            className="primary-button"
            type="button"
            key={encoding}
            disabled={busy}
            onClick={() => { void onConfirm(encoding); }}
          >
            {ENCODING_LABELS[encoding]}
          </button>
        ))}
      </div>
      <button
        className="text-button"
        type="button"
        disabled={busy}
        onClick={() => { void onChooseAnother(); }}
      >
        重新选择书稿
      </button>
    </section>
  );
}

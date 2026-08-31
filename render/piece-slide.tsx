// Shared PieceDoc slide renderer (ticket 11). The Studio live preview and
// the server-side PNG export both render THIS component, so preview equals
// export by construction. Everything here must stay deterministic: no
// randomness, no timestamps, no network fetches, inline styles only.

// tsx (the test runner) compiles JSX to the classic runtime, so React must
// be in scope by name.
import * as React from "react";
import type { CSSProperties, ReactElement } from "react";

export interface RenderFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderLayer {
  type: "text" | "image" | "shape" | "logo";
  text?: string;
  role?: string;
  ref?: string;
  alt?: string;
  shape?: string;
  fill?: string;
  variant?: string;
  frame?: RenderFrame;
}

export interface RenderSlide {
  layers: RenderLayer[];
}

export interface RenderDoc {
  format: string;
  slides: RenderSlide[];
  captions: Record<string, string>;
}

// Canvas size per PieceDoc format, in export pixels.
export const FORMAT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
};

// Placeholder brand palette until the Brand Kit ticket lands; layers
// reference tokens (`brand.<token>`), never copied values.
const BRAND_TOKENS: Record<string, string> = {
  ink: "#1f1b16",
  paper: "#f6f1e7",
  accent: "#1a6b54",
};

export function resolveFill(fill: string | undefined): string {
  if (!fill) return BRAND_TOKENS.ink;
  if (/^#[0-9a-fA-F]{6}$/.test(fill)) return fill.toLowerCase();
  const match = /^brand\.(\w+)$/.exec(fill);
  if (match) return BRAND_TOKENS[match[1]] ?? BRAND_TOKENS.ink;
  return BRAND_TOKENS.ink;
}

function frameStyle(frame: RenderFrame, width: number, height: number): CSSProperties {
  return {
    position: "absolute",
    left: Math.round(frame.x * width),
    top: Math.round(frame.y * height),
    width: Math.round(frame.w * width),
    height: Math.round(frame.h * height),
  };
}

function textSize(role: string | undefined, height: number): number {
  if (role === "headline") return Math.round(height * 0.06);
  if (role === "kicker") return Math.round(height * 0.025);
  return Math.round(height * 0.035);
}

function layerView(
  layer: RenderLayer,
  index: number,
  width: number,
  height: number
): ReactElement {
  const placed: CSSProperties = layer.frame
    ? frameStyle(layer.frame, width, height)
    : { position: "relative" };

  switch (layer.type) {
    case "text":
      return (
        <div
          key={index}
          data-layer={`${index}-text`}
          style={{
            ...placed,
            color: BRAND_TOKENS.ink,
            fontSize: textSize(layer.role, height),
            fontWeight: layer.role === "headline" ? 700 : 400,
            lineHeight: 1.25,
            whiteSpace: "pre-wrap",
          }}
        >
          {layer.text ?? ""}
        </div>
      );
    case "image":
      return (
        <div
          key={index}
          data-layer={`${index}-image`}
          style={{
            ...placed,
            minHeight: layer.frame ? undefined : Math.round(height * 0.25),
            background: "repeating-linear-gradient(45deg, #d8d2c6, #d8d2c6 24px, #e6e0d4 24px, #e6e0d4 48px)",
            border: `2px dashed ${BRAND_TOKENS.ink}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: Math.round(height * 0.02),
            color: BRAND_TOKENS.ink,
            textAlign: "center",
            overflow: "hidden",
          }}
        >
          {`image: ${layer.ref ?? ""}${layer.alt ? ` — ${layer.alt}` : ""}`}
        </div>
      );
    case "shape":
      return (
        <div
          key={index}
          data-layer={`${index}-shape`}
          style={{
            ...placed,
            minHeight: layer.frame ? undefined : Math.round(height * 0.08),
            backgroundColor: resolveFill(layer.fill),
            borderRadius: layer.shape === "circle" ? "50%" : 0,
          }}
        />
      );
    case "logo":
      return (
        <div
          key={index}
          data-layer={`${index}-logo`}
          style={{
            ...placed,
            display: "inline-flex",
            alignItems: "center",
            gap: Math.round(height * 0.008),
            fontSize: Math.round(height * 0.025),
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: BRAND_TOKENS.ink,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: Math.round(height * 0.03),
              height: Math.round(height * 0.03),
              backgroundColor: BRAND_TOKENS.accent,
              borderRadius: "50%",
            }}
          />
          {`logo${layer.variant ? ` · ${layer.variant}` : ""}`}
        </div>
      );
  }
}

export interface SlideViewProps {
  slide: RenderSlide;
  format: string;
}

export function SlideView({ slide, format }: SlideViewProps): ReactElement {
  const { width, height } = FORMAT_DIMENSIONS[format] ?? FORMAT_DIMENSIONS["1:1"];
  return (
    <div
      data-piece-slide={format}
      style={{
        position: "relative",
        width,
        height,
        backgroundColor: BRAND_TOKENS.paper,
        fontFamily: "Arial, Helvetica, sans-serif",
        padding: Math.round(height * 0.05),
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: Math.round(height * 0.02),
        overflow: "hidden",
      }}
    >
      {slide.layers.map((layer, index) => layerView(layer, index, width, height))}
    </div>
  );
}

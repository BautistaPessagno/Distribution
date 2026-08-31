// Shared PieceDoc slide renderer (ticket 11; Brand Kit tokens, ticket 12).
// The Studio live preview and the server-side PNG export both render THIS
// component, so preview equals export by construction. Everything here must
// stay deterministic: no randomness, no timestamps, no network fetches,
// inline styles only.
//
// Layers reference Brand Kit tokens (`brand.<name>`, `font.<name>`), never
// copied values. The token table is a render-time input, so changing a kit
// token repaints a piece without touching its stored document.

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
  color?: string;
  font?: string;
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

export type BrandTokens = Record<string, string>;

// The kit every Connected Project starts from. Colours are `brand.*`, type
// families are `font.*`; a piece names a token, the kit holds the value.
export const DEFAULT_BRAND_TOKENS: BrandTokens = {
  "brand.ink": "#1f1b16",
  "brand.paper": "#f6f1e7",
  "brand.accent": "#1a6b54",
  "font.display": "Arial, Helvetica, sans-serif",
  "font.body": "Arial, Helvetica, sans-serif",
};

export const COLOR_TOKEN_PREFIX = "brand.";
export const FONT_TOKEN_PREFIX = "font.";

export function isColorToken(value: string): boolean {
  return value.startsWith(COLOR_TOKEN_PREFIX);
}

export function isFontToken(value: string): boolean {
  return value.startsWith(FONT_TOKEN_PREFIX);
}

// Rendering never fails on an off-kit value: a raw colour paints as itself
// and an unknown token falls back to ink, so the Operator sees the piece.
// `check_brand` is what reports those values as errors.
export function resolveColor(
  value: string | undefined,
  tokens: BrandTokens = DEFAULT_BRAND_TOKENS
): string {
  const ink = tokens["brand.ink"] ?? DEFAULT_BRAND_TOKENS["brand.ink"];
  if (!value) return ink;
  if (isColorToken(value)) return tokens[value] ?? ink;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return ink;
}

export function resolveFont(
  value: string | undefined,
  fallbackToken: string,
  tokens: BrandTokens = DEFAULT_BRAND_TOKENS
): string {
  const fallback =
    tokens[fallbackToken] ?? DEFAULT_BRAND_TOKENS[fallbackToken] ?? DEFAULT_BRAND_TOKENS["font.body"];
  if (!value) return fallback;
  if (isFontToken(value)) return tokens[value] ?? fallback;
  return value;
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

export function textSize(role: string | undefined, height: number): number {
  if (role === "headline") return Math.round(height * 0.06);
  if (role === "kicker") return Math.round(height * 0.025);
  return Math.round(height * 0.035);
}

// The token a text layer's family comes from when it names none itself.
export function defaultFontToken(role: string | undefined): string {
  return role === "headline" ? "font.display" : "font.body";
}

export const CANVAS_PADDING_RATIO = 0.05;

// The box a text layer is laid out in, in export pixels: its own frame, or
// the padded canvas when it has none. `check_brand`'s overflow test and the
// renderer agree because both read this.
export function textLayerBox(
  layer: RenderLayer,
  format: string
): { width: number; height: number } {
  const { width, height } = FORMAT_DIMENSIONS[format] ?? FORMAT_DIMENSIONS["1:1"];
  if (layer.frame) {
    return {
      width: Math.round(layer.frame.w * width),
      height: Math.round(layer.frame.h * height),
    };
  }
  const padding = Math.round(height * CANVAS_PADDING_RATIO);
  return { width: width - padding * 2, height: height - padding * 2 };
}

function layerView(
  layer: RenderLayer,
  index: number,
  width: number,
  height: number,
  tokens: BrandTokens
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
            color: resolveColor(layer.color ?? "brand.ink", tokens),
            fontFamily: resolveFont(layer.font, defaultFontToken(layer.role), tokens),
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
            border: `2px dashed ${resolveColor("brand.ink", tokens)}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: Math.round(height * 0.02),
            color: resolveColor("brand.ink", tokens),
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
            backgroundColor: resolveColor(layer.fill, tokens),
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
            fontFamily: resolveFont(undefined, "font.display", tokens),
            fontSize: Math.round(height * 0.025),
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: resolveColor("brand.ink", tokens),
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: Math.round(height * 0.03),
              height: Math.round(height * 0.03),
              backgroundColor: resolveColor("brand.accent", tokens),
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
  /** Brand Kit token table; omitted means the default kit. */
  tokens?: BrandTokens;
}

export function SlideView({ slide, format, tokens }: SlideViewProps): ReactElement {
  const kit = tokens ?? DEFAULT_BRAND_TOKENS;
  const { width, height } = FORMAT_DIMENSIONS[format] ?? FORMAT_DIMENSIONS["1:1"];
  return (
    <div
      data-piece-slide={format}
      style={{
        position: "relative",
        width,
        height,
        backgroundColor: resolveColor("brand.paper", kit),
        fontFamily: resolveFont(undefined, "font.body", kit),
        padding: Math.round(height * CANVAS_PADDING_RATIO),
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: Math.round(height * 0.02),
        overflow: "hidden",
      }}
    >
      {slide.layers.map((layer, index) => layerView(layer, index, width, height, kit))}
    </div>
  );
}

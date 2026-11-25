import type { Collection } from '../api/types';
import { derivePlainText } from './document';

export type ShareCardTemplate = 'paper' | 'midnight' | 'gallery' | 'quote';

export interface ShareCardTemplateOption {
  id: ShareCardTemplate;
  label: string;
  swatch: string;
  accent: string;
}

export const SHARE_CARD_TEMPLATES: readonly ShareCardTemplateOption[] = [
  { id: 'paper', label: '手帐纸笺', swatch: '#F7F3EA', accent: '#2A8369' },
  { id: 'midnight', label: '胶片暗房', swatch: '#101F1A', accent: '#7FD6B8' },
  { id: 'gallery', label: '展览海报', swatch: '#FFFFFF', accent: '#2C3E38' },
  { id: 'quote', label: '极简金句', swatch: '#15332A', accent: '#C6EBD9' },
];

export function selectDefaultShareTemplate(body: string, imageCount: number): ShareCardTemplate {
  if (imageCount > 0) return 'gallery';
  if ([...body.trim()].length <= 60) return 'quote';
  return 'paper';
}

function stripUrlsFromShareBody(raw: string): string {
  return raw
    .replace(/(?:https?:\/\/|www\.)[^\s<>"]+/giu, (match) => {
      // Preserve trailing sentence-ending punctuation only when no query/fragment exists
      // and never break early inside URLs containing apostrophes or CJK brackets/commas.
      if (!match.includes('?') && !match.includes('#')) {
        const trailing = match.match(/([，。！？；：,.!?'])$/u);
        if (trailing) return trailing[1];
      }
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shareText(collection: Collection, showSource: boolean, showProjects: boolean) {
  // Derive full visible paragraph text before stripping URLs so split marks or partial links are removed consistently.
  const rawBody = [
    derivePlainText(collection.document),
    ...(collection.image_notes ?? []).map((note) => note.text),
  ]
    .filter(Boolean)
    .join('\n\n');
  const body = stripUrlsFromShareBody(rawBody);
  let source = '';
  if (showSource && collection.original_url) {
    try {
      const url = new URL(collection.original_url);
      if (['http:', 'https:'].includes(url.protocol)) source = url.origin + url.pathname;
    } catch { /* A legacy invalid source is omitted. */ }
  }
  return {
    body,
    date: new Date(collection.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }),
    source,
    projects: showProjects ? collection.projects.filter(p => ['manual','confirmed','auto'].includes(p.decision)).map(p => p.name).join('、') : '',
  };
}

export async function decodeThumbnail(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CANVAS_WIDTH = 1080;
const SERIF_FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif';
const SANS_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const ROUND_FONT = 'ui-rounded, "SF Pro Rounded", "PingFang SC", sans-serif';

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

function splitGraphemes(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  const out: string[] = [];
  for (const seg of graphemeSegmenter.segment(text)) {
    out.push(seg.segment);
  }
  return out;
}

function fitEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = '';
  for (const ch of splitGraphemes(text)) {
    if (ctx.measureText(`${out}${ch}…`).width > maxWidth) {
      return out ? `${out}…` : '…';
    }
    out += ch;
  }
  return out;
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const trimmed = text.trim();
  if (!trimmed || maxLines <= 0) return [];

  const visible: string[] = [];
  let hasOverflow = false;
  const paragraphs = trimmed.split('\n');

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
    const paragraph = paragraphs[pIdx];
    const graphemes = splitGraphemes(paragraph);
    let line = '';

    for (let gIdx = 0; gIdx < graphemes.length; gIdx += 1) {
      const grapheme = graphemes[gIdx];
      if (ctx.measureText(line + grapheme).width > maxWidth && line !== '') {
        visible.push(line);
        if (visible.length === maxLines) {
          hasOverflow = true;
          break;
        }
        line = grapheme;
      } else {
        line += grapheme;
      }
    }

    if (hasOverflow) break;

    visible.push(line);
    if (visible.length === maxLines) {
      if (pIdx < paragraphs.length - 1) {
        hasOverflow = true;
      }
      break;
    }
  }

  if (hasOverflow && visible.length > 0) {
    const lastIdx = visible.length - 1;
    visible[lastIdx] = fitEllipsis(ctx, `${visible[lastIdx]}…`, maxWidth);
  }
  return visible;
}

function drawRoundedImageCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const iw = Math.max(1, image.naturalWidth || w);
  const ih = Math.max(1, image.naturalHeight || h);
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.clip();
  ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

function drawRoundedImageContain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  bgColor: string,
) {
  const iw = Math.max(1, image.naturalWidth || w);
  const ih = Math.max(1, image.naturalHeight || h);
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.clip();
  ctx.drawImage(image, dx, dy, dw, dh);
  ctx.restore();
}

function drawImageBlock(
  ctx: CanvasRenderingContext2D,
  images: readonly HTMLImageElement[],
  x: number,
  y: number,
  width: number,
  options: {
    singleGoldenCrop?: boolean;
    radius: number;
    gap: number;
    cellBg: string;
    shadowColor?: string;
  },
): number {
  if (images.length === 0) return 0;

  if (images.length === 1) {
    const img = images[0];
    const iw = Math.max(1, img.naturalWidth || 4);
    const ih = Math.max(1, img.naturalHeight || 3);
    const height = options.singleGoldenCrop
      ? Math.round(width / 1.48)
      : Math.min(680, Math.max(260, Math.round((width * ih) / iw)));

    ctx.save();
    if (options.shadowColor) {
      ctx.shadowColor = options.shadowColor;
      ctx.shadowBlur = 28;
      ctx.shadowOffsetY = 12;
    }
    ctx.fillStyle = options.cellBg;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, options.radius);
    ctx.fill();
    ctx.restore();

    if (options.singleGoldenCrop) {
      drawRoundedImageCover(ctx, img, x, y, width, height, options.radius);
    } else {
      drawRoundedImageContain(ctx, img, x, y, width, height, options.radius, options.cellBg);
    }
    return height;
  }

  const columns = images.length > 4 ? 3 : 2;
  const cellWidth = (width - (columns - 1) * options.gap) / columns;
  const cellHeight = Math.round(cellWidth * 0.82);
  const rows = Math.ceil(images.length / columns);

  images.forEach((img, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cx = x + col * (cellWidth + options.gap);
    const cy = y + row * (cellHeight + options.gap);

    ctx.save();
    if (options.shadowColor) {
      ctx.shadowColor = options.shadowColor;
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
    }
    ctx.fillStyle = options.cellBg;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cellWidth, cellHeight, Math.max(12, options.radius - 4));
    ctx.fill();
    ctx.restore();

    drawRoundedImageCover(
      ctx,
      img,
      cx,
      cy,
      cellWidth,
      cellHeight,
      Math.max(12, options.radius - 4),
    );
  });

  return rows * cellHeight + (rows - 1) * options.gap;
}

function drawSparkJarBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  jarColor: string,
  sparkColor: string,
  wordColor: string,
) {
  ctx.save();
  ctx.translate(x, y);
  const s = 1.45;
  ctx.scale(s, s);

  // Jar lid
  ctx.fillStyle = jarColor;
  ctx.beginPath();
  ctx.roundRect(7.4, 2.4, 9.2, 3.3, 1.5);
  ctx.fill();

  // Jar outline
  ctx.strokeStyle = jarColor;
  ctx.lineWidth = 1.9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(8.6, 5.7);
  ctx.lineTo(8.6, 7.2);
  ctx.bezierCurveTo(6.5, 8.1, 5, 10, 5, 12.5);
  ctx.lineTo(5, 16.9);
  ctx.bezierCurveTo(5, 19.4, 7, 21.5, 9.6, 21.5);
  ctx.lineTo(14.4, 21.5);
  ctx.bezierCurveTo(17, 21.5, 19, 19.4, 19, 16.9);
  ctx.lineTo(19, 12.5);
  ctx.bezierCurveTo(19, 10, 17.5, 8.1, 15.4, 7.2);
  ctx.lineTo(15.4, 5.7);
  ctx.stroke();

  // 4-point spark inside jar
  ctx.fillStyle = sparkColor;
  ctx.beginPath();
  ctx.moveTo(12, 10.5);
  ctx.quadraticCurveTo(12.8, 13.7, 16, 14.5);
  ctx.quadraticCurveTo(12.8, 15.3, 12, 18.5);
  ctx.quadraticCurveTo(11.2, 15.3, 8, 14.5);
  ctx.quadraticCurveTo(11.2, 13.7, 12, 10.5);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(15.3, 10.4, 0.9, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  ctx.save();
  ctx.fillStyle = wordColor;
  ctx.font = `700 30px ${ROUND_FONT}`;
  ctx.fillText('Spark', x + 44, y + 27);
  ctx.restore();
}

function drawPaperNoise(ctx: CanvasRenderingContext2D, width: number, height: number, tint: string) {
  ctx.save();
  ctx.fillStyle = tint;
  let seed = 42197;
  const count = Math.round((width * height) / 1400);
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = seed % width;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = seed % height;
    const size = (seed & 1) === 0 ? 1.5 : 1;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

export async function renderShareCard(
  content: ReturnType<typeof shareText>,
  images: readonly HTMLImageElement[] = [],
  template: ShareCardTemplate = selectDefaultShareTemplate(content.body, images.length),
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片。');

  const padX = template === 'paper' ? 120 : template === 'gallery' ? 104 : 112;
  const contentWidth = CANVAS_WIDTH - padX * 2;
  const hasMetaFooter = Boolean(content.source || content.projects);
  const metaHeight = (content.source ? 36 : 0) + (content.projects ? 36 : 0) + (hasMetaFooter ? 14 : 0);

  if (template === 'quote') {
    const isShort = splitGraphemes(content.body.trim()).length <= 42;
    const fontSize = isShort ? 44 : 36;
    const lineHeight = isShort ? 72 : 60;
    ctx.font = `500 ${fontSize}px ${SERIF_FONT}`;
    const lines = wrapTextLines(ctx, content.body, contentWidth - 40, 10);

    const textStartY = 232;
    const textBottomY =
      lines.length > 0 ? textStartY + (lines.length - 1) * lineHeight + 24 : 196;

    const quoteCols = images.length <= 3 ? Math.max(1, images.length) : 3;
    const quoteThumbGap = 16;
    const quoteThumbSize = images.length <= 3 ? 152 : 136;
    const quoteRows = images.length > 0 ? Math.ceil(images.length / quoteCols) : 0;
    const imgStartY = textBottomY + 28;
    const previewImgHeight =
      quoteRows > 0 ? quoteRows * quoteThumbSize + (quoteRows - 1) * quoteThumbGap : 0;
    const contentBottomY =
      images.length > 0 ? imgStartY + previewImgHeight : textBottomY;

    const footerContentHeight =
      42 + (content.projects ? 36 : 0) + (content.source ? 36 : 0) + 32 + 38 + 56;
    const minLineY = 760 - footerContentHeight;
    const lineY = Math.max(contentBottomY + 44, minLineY);
    let calcMetaY = lineY + 42;
    if (content.projects) calcMetaY += 36;
    if (content.source) calcMetaY += 36;
    const badgeY = calcMetaY + 32;
    canvas.height = badgeY + 38 + 56;

    const grad = ctx.createRadialGradient(
      CANVAS_WIDTH * 0.5,
      canvas.height * 0.28,
      60,
      CANVAS_WIDTH * 0.5,
      canvas.height * 0.5,
      canvas.height * 0.78,
    );
    grad.addColorStop(0, '#1D4639');
    grad.addColorStop(1, '#0F241D');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_WIDTH, canvas.height);
    drawPaperNoise(ctx, CANVAS_WIDTH, canvas.height, 'rgba(255, 255, 255, 0.026)');

    // Inner quiet border frame
    ctx.strokeStyle = 'rgba(206, 238, 223, 0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(42, 42, CANVAS_WIDTH - 84, canvas.height - 84, 28);
    ctx.stroke();

    // Decorative giant opening quote mark
    ctx.fillStyle = 'rgba(195, 238, 218, 0.24)';
    ctx.font = `700 124px ${SERIF_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('“', CANVAS_WIDTH / 2, 162);

    // Centered body
    ctx.fillStyle = '#F5F1E8';
    ctx.font = `500 ${fontSize}px ${SERIF_FONT}`;
    let cursorY = textStartY;
    for (const line of lines) {
      ctx.fillText(line, CANVAS_WIDTH / 2, cursorY);
      cursorY += lineHeight;
    }

    if (images.length > 0) {
      images.forEach((img, idx) => {
        const row = Math.floor(idx / quoteCols);
        const col = idx % quoteCols;
        const itemsInRow = Math.min(quoteCols, images.length - row * quoteCols);
        const rowWidth = itemsInRow * quoteThumbSize + (itemsInRow - 1) * quoteThumbGap;
        const startX = (CANVAS_WIDTH - rowWidth) / 2;
        drawRoundedImageCover(
          ctx,
          img,
          startX + col * (quoteThumbSize + quoteThumbGap),
          imgStartY + row * (quoteThumbSize + quoteThumbGap),
          quoteThumbSize,
          quoteThumbSize,
          16,
        );
      });
    }

    // Centered hairline & footer positioned strictly below contentBottomY
    ctx.strokeStyle = 'rgba(206, 238, 223, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(CANVAS_WIDTH / 2 - 90, lineY);
    ctx.lineTo(CANVAS_WIDTH / 2 + 90, lineY);
    ctx.stroke();

    ctx.font = `500 24px ${SANS_FONT}`;
    ctx.fillStyle = 'rgba(222, 238, 230, 0.72)';
    let metaY = lineY + 42;
    ctx.fillText(content.date, CANVAS_WIDTH / 2, metaY);
    if (content.projects) {
      metaY += 36;
      ctx.fillText(fitEllipsis(ctx, content.projects, contentWidth), CANVAS_WIDTH / 2, metaY);
    }
    if (content.source) {
      metaY += 36;
      ctx.fillText(fitEllipsis(ctx, content.source, contentWidth), CANVAS_WIDTH / 2, metaY);
    }

    ctx.textAlign = 'left';
    drawSparkJarBadge(ctx, CANVAS_WIDTH / 2 - 66, badgeY, '#B6E5D0', '#FFE4B8', '#E9F5EF');

    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('PNG 生成失败。'))),
        'image/png',
      ),
    );
  }

  // Layout measurements for paper / midnight / gallery
  const bodyFontSize = 36;
  const bodyLineHeight = 58;
  ctx.font = `400 ${bodyFontSize}px ${template === 'gallery' ? SANS_FONT : SERIF_FONT}`;
  const maxBodyLines = images.length > 0 ? 7 : 12;
  const lines = wrapTextLines(ctx, content.body, contentWidth, maxBodyLines);
  const bodyHeight = lines.length > 0 ? lines.length * bodyLineHeight : 0;

  // Estimate image height via a dummy measurement pass
  let estImageHeight = 0;
  if (images.length > 0) {
    if (images.length === 1) {
      const iw = Math.max(1, images[0].naturalWidth || 4);
      const ih = Math.max(1, images[0].naturalHeight || 3);
      estImageHeight =
        template === 'gallery'
          ? Math.round(contentWidth / 1.48)
          : Math.min(680, Math.max(260, Math.round((contentWidth * ih) / iw)));
    } else {
      const cols = images.length > 4 ? 3 : 2;
      const gap = 16;
      const cellW = (contentWidth - (cols - 1) * gap) / cols;
      const cellH = Math.round(cellW * 0.82);
      const rows = Math.ceil(images.length / cols);
      estImageHeight = rows * cellH + (rows - 1) * gap;
    }
  }

  const headerHeight = template === 'gallery' ? 88 : 156;
  const imageGap = estImageHeight > 0 && bodyHeight > 0 ? 40 : 0;
  const footerBlock = 128 + metaHeight;
  const outerPadY = template === 'gallery' ? 68 : 64;

  canvas.height = Math.max(
    640,
    outerPadY * 2 + headerHeight + estImageHeight + imageGap + bodyHeight + footerBlock,
  );

  if (template === 'midnight') {
    const bgGrad = ctx.createRadialGradient(
      CANVAS_WIDTH * 0.5,
      canvas.height * 0.22,
      40,
      CANVAS_WIDTH * 0.5,
      canvas.height * 0.55,
      canvas.height * 0.88,
    );
    bgGrad.addColorStop(0, '#163128');
    bgGrad.addColorStop(0.55, '#0F1F1A');
    bgGrad.addColorStop(1, '#09110E');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, CANVAS_WIDTH, canvas.height);

    // Subtle film darkroom frame
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.beginPath();
    ctx.roundRect(52, 52, CANVAS_WIDTH - 104, canvas.height - 104, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(182, 232, 211, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Date stamp
    ctx.fillStyle = 'rgba(182, 232, 211, 0.78)';
    ctx.font = `600 24px ${SANS_FONT}`;
    ctx.fillText(content.date, padX, 128);

    ctx.strokeStyle = 'rgba(182, 232, 211, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padX, 150);
    ctx.lineTo(padX + 44, 150);
    ctx.stroke();

    let cursorY = 194;
    if (images.length > 0) {
      const drawnH = drawImageBlock(ctx, images, padX, cursorY, contentWidth, {
        radius: 18,
        gap: 16,
        cellBg: '#12241E',
        shadowColor: 'rgba(0, 0, 0, 0.48)',
      });
      cursorY += drawnH + (bodyHeight > 0 ? 40 : 0);
    }

    if (lines.length > 0) {
      ctx.fillStyle = '#F3EFE6';
      ctx.font = `400 ${bodyFontSize}px ${SERIF_FONT}`;
      lines.forEach((line, idx) => {
        ctx.fillText(line, padX, cursorY + 34 + idx * bodyLineHeight);
      });
    }

    const sepY = canvas.height - 150 - metaHeight;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, sepY);
    ctx.lineTo(CANVAS_WIDTH - padX, sepY);
    ctx.stroke();

    ctx.font = `400 23px ${SANS_FONT}`;
    ctx.fillStyle = 'rgba(214, 230, 223, 0.65)';
    let metaY = sepY + 36;
    if (content.source) {
      ctx.fillText(fitEllipsis(ctx, content.source, contentWidth), padX, metaY);
      metaY += 34;
    }
    if (content.projects) {
      ctx.fillText(fitEllipsis(ctx, content.projects, contentWidth), padX, metaY);
    }

    drawSparkJarBadge(ctx, padX, canvas.height - 114, '#88D4B8', '#FFE4B8', '#E9F5EF');
  } else if (template === 'gallery') {
    ctx.fillStyle = '#F1F2EE';
    ctx.fillRect(0, 0, CANVAS_WIDTH, canvas.height);

    // Gallery poster board
    ctx.save();
    ctx.shadowColor = 'rgba(24, 34, 30, 0.08)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(48, 48, CANVAS_WIDTH - 96, canvas.height - 96, 26);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(40, 52, 48, 0.08)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(48, 48, CANVAS_WIDTH - 96, canvas.height - 96, 26);
    ctx.stroke();

    let cursorY = 104;
    if (images.length > 0) {
      const drawnH = drawImageBlock(ctx, images, padX, cursorY, contentWidth, {
        singleGoldenCrop: true,
        radius: 20,
        gap: 16,
        cellBg: '#E7EAE5',
        shadowColor: 'rgba(20, 30, 26, 0.1)',
      });
      cursorY += drawnH + (bodyHeight > 0 ? 40 : 0);
    }

    if (lines.length > 0) {
      ctx.fillStyle = '#1F2A26';
      ctx.font = `400 ${bodyFontSize}px ${SANS_FONT}`;
      lines.forEach((line, idx) => {
        ctx.fillText(line, padX, cursorY + 34 + idx * bodyLineHeight);
      });
    }

    const sepY = canvas.height - 154 - metaHeight;
    ctx.strokeStyle = 'rgba(40, 52, 48, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, sepY);
    ctx.lineTo(CANVAS_WIDTH - padX, sepY);
    ctx.stroke();

    ctx.font = `500 23px ${SANS_FONT}`;
    ctx.fillStyle = '#6B7C75';
    let metaY = sepY + 36;
    if (content.source) {
      ctx.fillText(fitEllipsis(ctx, content.source, contentWidth), padX, metaY);
      metaY += 34;
    }
    if (content.projects) {
      ctx.fillText(fitEllipsis(ctx, content.projects, contentWidth), padX, metaY);
    }

    drawSparkJarBadge(ctx, padX, canvas.height - 118, '#2A8369', '#EC9A78', '#2C3E38');

    ctx.font = `500 24px ${SANS_FONT}`;
    ctx.fillStyle = '#6B7C75';
    ctx.textAlign = 'right';
    ctx.fillText(content.date, CANVAS_WIDTH - padX, canvas.height - 91);
    ctx.textAlign = 'left';
  } else {
    // 'paper' (手帐纸笺)
    ctx.fillStyle = '#F5EFE3';
    ctx.fillRect(0, 0, CANVAS_WIDTH, canvas.height);
    drawPaperNoise(ctx, CANVAS_WIDTH, canvas.height, 'rgba(110, 92, 68, 0.04)');

    ctx.save();
    ctx.shadowColor = 'rgba(72, 58, 38, 0.1)';
    ctx.shadowBlur = 42;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#FFFDF8';
    ctx.beginPath();
    ctx.roundRect(56, 56, CANVAS_WIDTH - 112, canvas.height - 112, 30);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(120, 102, 76, 0.14)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(56, 56, CANVAS_WIDTH - 112, canvas.height - 112, 30);
    ctx.stroke();

    // Magazine date postmark stamp
    ctx.font = `600 23px ${ROUND_FONT}`;
    const stampW = ctx.measureText(content.date).width + 38;
    ctx.fillStyle = '#EFE7D8';
    ctx.beginPath();
    ctx.roundRect(padX, 106, stampW, 48, 999);
    ctx.fill();
    ctx.fillStyle = '#6C5E4B';
    ctx.fillText(content.date, padX + 19, 138);

    let cursorY = 194;
    if (images.length > 0) {
      const drawnH = drawImageBlock(ctx, images, padX, cursorY, contentWidth, {
        radius: 18,
        gap: 16,
        cellBg: '#F1ECE2',
        shadowColor: 'rgba(60, 48, 32, 0.12)',
      });
      cursorY += drawnH + (bodyHeight > 0 ? 40 : 0);
    }

    if (lines.length > 0) {
      ctx.fillStyle = '#2B251E';
      ctx.font = `400 ${bodyFontSize}px ${SERIF_FONT}`;
      lines.forEach((line, idx) => {
        ctx.fillText(line, padX, cursorY + 34 + idx * bodyLineHeight);
      });
    }

    const sepY = canvas.height - 156 - metaHeight;
    ctx.strokeStyle = 'rgba(120, 102, 76, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, sepY);
    ctx.lineTo(CANVAS_WIDTH - padX, sepY);
    ctx.stroke();

    ctx.font = `400 23px ${SANS_FONT}`;
    ctx.fillStyle = '#756857';
    let metaY = sepY + 36;
    if (content.source) {
      ctx.fillText(fitEllipsis(ctx, content.source, contentWidth), padX, metaY);
      metaY += 34;
    }
    if (content.projects) {
      ctx.fillText(fitEllipsis(ctx, content.projects, contentWidth), padX, metaY);
    }

    drawSparkJarBadge(ctx, padX, canvas.height - 120, '#2A8369', '#EC9A78', '#2B251E');
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG 生成失败。'))),
      'image/png',
    ),
  );
}

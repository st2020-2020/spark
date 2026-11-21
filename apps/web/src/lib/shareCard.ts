import type { Collection } from '../api/types';
import { derivePlainText } from './document';

export function shareText(collection: Collection, showSource: boolean, showProjects: boolean) {
  // Only draw plain body text. Link targets, attachments, purpose and generated titles stay private.
  let body = derivePlainText(collection.document);
  if (collection.original_url) body = body.split(collection.original_url).join('');
  body = body.replace(/(?:https?:\/\/|www\.)[^\s<>\u3000，。！？]+/giu, '').trim();
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

export async function renderShareCard(content: ReturnType<typeof shareText>): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 840;
  canvas.height = 960;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片。');
  const styles = getComputedStyle(document.documentElement);
  const color = (token: string) => styles.getPropertyValue('--sp-' + token).trim();
  ctx.fillStyle = color('bg');
  ctx.fillRect(0, 0, 840, 960);
  ctx.fillStyle = color('border');
  for (let x = 12; x < 840; x += 20) for (let y = 12; y < 960; y += 20) ctx.fillRect(x, y, 2, 2);
  ctx.fillStyle = color('surface');
  ctx.fillRect(36, 38, 768, 884);
  ctx.font = 'bold 26px sans-serif';
  ctx.fillStyle = color('accent');
  ctx.beginPath();
  ctx.roundRect(66, 82, ctx.measureText(content.date).width + 28, 54, 8);
  ctx.fill();
  ctx.fillStyle = color('accent-fg');
  ctx.fillText(content.date, 80, 120);
  ctx.fillStyle = color('fg');
  ctx.font = '34px sans-serif';
  let line = '';
  const lines: string[] = [];
  for (const char of content.body) {
    if (char === '\n' || ctx.measureText(line + char).width > 680) {
      lines.push(line);
      line = '';
      if (lines.length === 11) break;
    }
    if (char !== '\n') line += char;
  }
  lines.push(line);
  const excerpt = lines.length > 11;
  lines.slice(0, 11).forEach((text, i) => ctx.fillText(text, 80, 209 + i * 47));
  ctx.fillStyle = color('muted');
  ctx.font = '24px sans-serif';
  if (excerpt) ctx.fillText('节选', 80, 729);
  function footerLine(value: string, y: number) {
    if (!value) return;
    let result = '';
    for (const char of value) {
      if (ctx!.measureText(result + char + '…').width > 680) {
        result += '…';
        break;
      }
      result += char;
    }
    ctx!.fillText(result, 80, y);
  }
  footerLine(content.source, 777);
  footerLine(content.projects, 813);
  ctx.fillStyle = color('primary');
  ctx.fillRect(83, 845, 24, 7);
  ctx.lineWidth = 3;
  ctx.strokeStyle = color('primary');
  ctx.beginPath();
  ctx.roundRect(80, 854, 30, 32, 7);
  ctx.stroke();
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('Spark', 124, 881);
  return new Promise((resolve, reject) => canvas.toBlob(blob =>
    blob ? resolve(blob) : reject(new Error('PNG 生成失败。')), 'image/png'));
}

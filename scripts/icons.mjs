// Renders branding/logo.svg into the icon files the build copies over
// upstream's: the Windows .ico, Start menu tiles and installer bitmaps, and
// the Linux icon. Run it after changing the logo; the output is committed.
//
//   npm install && npm run icons

import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { log, root } from './lib.mjs';

const logo = fs.readFileSync(path.join(root, 'branding', 'logo.svg'));
const logoHref = `data:image/svg+xml;base64,${logo.toString('base64')}`;
const out = dir => {
	const full = path.join(root, 'branding', dir);
	fs.mkdirSync(full, { recursive: true });
	return full;
};

// Logo centered on a canvas; `background` is omitted for transparent output.
function render(width, height, logoSize, background) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
		+ (background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : '')
		+ `<image href="${logoHref}" x="${(width - logoSize) / 2}" y="${(height - logoSize) / 2}" width="${logoSize}" height="${logoSize}"/>`
		+ '</svg>';
	return new Resvg(svg).render();
}

// resvg returns premultiplied RGBA; icons and bitmaps want straight alpha.
function straightRgba(image) {
	const pixels = Buffer.from(image.pixels);
	for (let i = 0; i < pixels.length; i += 4) {
		const alpha = pixels[i + 3];
		if (alpha > 0 && alpha < 255) {
			for (let c = 0; c < 3; c++) {
				pixels[i + c] = Math.min(255, Math.round(pixels[i + c] * 255 / alpha));
			}
		}
	}
	return pixels;
}

// 32-bit DIB entry (BGRA rows bottom-up, followed by the 1-bit AND mask).
function iconDib(size) {
	const rgba = straightRgba(render(size, size, size));
	const maskRow = Math.ceil(size / 32) * 4;
	const dib = Buffer.alloc(40 + size * size * 4 + maskRow * size);
	dib.writeUInt32LE(40, 0);
	dib.writeInt32LE(size, 4);
	dib.writeInt32LE(size * 2, 8);
	dib.writeUInt16LE(1, 12);
	dib.writeUInt16LE(32, 14);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const from = (y * size + x) * 4;
			const to = 40 + ((size - 1 - y) * size + x) * 4;
			dib[to] = rgba[from + 2];
			dib[to + 1] = rgba[from + 1];
			dib[to + 2] = rgba[from];
			dib[to + 3] = rgba[from + 3];
			if (rgba[from + 3] === 0) {
				const maskOffset = 40 + size * size * 4 + (size - 1 - y) * maskRow + (x >> 3);
				dib[maskOffset] |= 0x80 >> (x & 7);
			}
		}
	}
	return dib;
}

function ico(sizes) {
	const images = sizes.map(size => ({ size, data: size >= 256 ? render(size, size, size).asPng() : iconDib(size) }));
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, index) => {
		const entry = 6 + 16 * index;
		header[entry] = size >= 256 ? 0 : size;
		header[entry + 1] = size >= 256 ? 0 : size;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map(image => image.data)]);
}

// 24-bit BMP, the format Inno Setup's wizard images use.
function bmp(width, height, logoSize) {
	const rgba = straightRgba(render(width, height, logoSize, '#000000'));
	const rowSize = Math.ceil(width * 3 / 4) * 4;
	const file = Buffer.alloc(54 + rowSize * height);
	file.write('BM', 0, 'ascii');
	file.writeUInt32LE(file.length, 2);
	file.writeUInt32LE(54, 10);
	file.writeUInt32LE(40, 14);
	file.writeInt32LE(width, 18);
	file.writeInt32LE(height, 22);
	file.writeUInt16LE(1, 26);
	file.writeUInt16LE(24, 28);
	file.writeUInt32LE(rowSize * height, 34);
	file.writeInt32LE(2835, 38);
	file.writeInt32LE(2835, 42);
	for (let y = 0; y < height; y++) {
		const row = 54 + (height - 1 - y) * rowSize;
		for (let x = 0; x < width; x++) {
			const from = (y * width + x) * 4;
			file[row + x * 3] = rgba[from + 2];
			file[row + x * 3 + 1] = rgba[from + 1];
			file[row + x * 3 + 2] = rgba[from];
		}
	}
	return file;
}

const win32 = out('win32');
fs.writeFileSync(path.join(win32, 'code.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(win32, 'code_70x70.png'), render(70, 70, 56).asPng());
fs.writeFileSync(path.join(win32, 'code_150x150.png'), render(150, 150, 96).asPng());

// Installer wizard images, one per DPI scale; sizes match upstream's files.
const wizardSizes = {
	'100': [[164, 314], [55, 55]],
	'125': [[192, 386], [64, 68]],
	'150': [[246, 459], [83, 80]],
	'175': [[273, 556], [92, 97]],
	'200': [[328, 604], [110, 106]],
	'225': [[355, 700], [119, 123]],
	'250': [[410, 797], [138, 140]],
};
for (const [scale, [[bigWidth, bigHeight], [smallWidth, smallHeight]]] of Object.entries(wizardSizes)) {
	fs.writeFileSync(path.join(win32, `inno-big-${scale}.bmp`), bmp(bigWidth, bigHeight, Math.round(bigWidth * 0.5)));
	fs.writeFileSync(path.join(win32, `inno-small-${scale}.bmp`), bmp(smallWidth, smallHeight, Math.round(Math.min(smallWidth, smallHeight) * 0.8)));
}

fs.writeFileSync(path.join(out('linux'), 'code.png'), render(1024, 1024, 1024).asPng());

log('icons written to branding/win32 and branding/linux');

// Byte limits apply to the original file; previews never replace the original.
var MAX_BYTES = 10 * 1024 * 1024;
var MAX_HISTORY_BYTES = 40 * 1024 * 1024;
var MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
var PREVIEW_WIDTH = 256;
var PREVIEW_HEIGHT = 192;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function metadata(value) {
    if (
        !value ||
        !MIME_TYPES.includes(value.mime) ||
        !Number.isInteger(value.size) ||
        value.size < 1 ||
        value.size > MAX_BYTES ||
        typeof value.name !== 'string' ||
        value.name.length > 128
    )
        return null;
    const name = value.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim() || 'image';
    return { mime: value.mime, size: value.size, name };
}

function detectMime(bytes) {
    const starts = (signature) =>
        bytes?.length >= signature.length &&
        signature.every((byte, index) => bytes[index] === byte);
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
    if (starts([255, 216, 255])) return 'image/jpeg';
    if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])) return 'image/gif';
    if (
        starts([82, 73, 70, 70]) &&
        bytes.length >= 12 &&
        [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte)
    )
        return 'image/webp';
    return null;
}

function validate(value) {
    const info = metadata(value);
    const data = value?.data;
    if (
        !info ||
        typeof data !== 'string' ||
        data.length !== Math.ceil(info.size / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
        return null;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if ((data.length / 4) * 3 - padding !== info.size) return null;
    // Reject alternate encodings with non-zero unused padding bits.
    const tail = BASE64.indexOf(data[data.length - padding - 1]);
    if ((padding === 2 && tail & 15) || (padding === 1 && tail & 3)) return null;
    const header = [];
    let bits = 0,
        count = 0;
    for (const char of data.slice(0, 16)) {
        const value = BASE64.indexOf(char);
        if (value < 0) break;
        bits = (bits << 6) | value;
        count += 6;
        if (count >= 8) {
            count -= 8;
            header.push((bits >> count) & 255);
        }
    }
    if (detectMime(header) !== info.mime) return null;
    return { ...info, data };
}

function fit(width, height, maxWidth = PREVIEW_WIDTH, maxHeight = PREVIEW_HEIGHT) {
    if (![width, height, maxWidth, maxHeight].every((value) => Number.isFinite(value) && value > 0))
        return null;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function summary(image) {
    return `[Image] ${image.name}`;
}

if (typeof module !== 'undefined')
    module.exports = {
        MAX_BYTES,
        MAX_HISTORY_BYTES,
        MIME_TYPES,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
        metadata,
        detectMime,
        validate,
        fit,
        summary,
    };

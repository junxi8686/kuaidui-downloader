/* 极简 ZIP 打包（store 模式，不压缩）
 * JPEG 已经是压缩数据，再 deflate 基本没收益，所以直接 store，
 * 好处是零依赖、写得下、任何解压工具都认。
 */
(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(bytes);
  }

  function dosTime(d) {
    d = d || new Date();
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
      date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }

  function Writer() { this.parts = []; this.size = 0; this.offset = 0; }
  Writer.prototype.push = function (u8) { this.parts.push(u8); this.size += u8.length; };

  function u16(v) { return new Uint8Array([v & 255, (v >> 8) & 255]); }
  function u32(v) { return new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]); }

  /**
   * files: [{ name: 'a/b.jpg', data: Uint8Array }]
   * 返回 Uint8Array
   */
  function zip(files) {
    var out = new Writer();
    var central = [];
    var stamp = dosTime(new Date());

    files.forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = f.data;
      var crc = crc32(data);
      var localOffset = out.size;

      // 本地文件头
      var header = [];
      header.push(u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
      header.forEach(function (h) { out.push(h); });
      out.push(nameBytes);
      out.push(data);

      central.push({ nameBytes: nameBytes, crc: crc, size: data.length, offset: localOffset });
    });

    var cdStart = out.size;
    central.forEach(function (c) {
      var rec = [];
      rec.push(u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
        u32(c.crc), u32(c.size), u32(c.size), u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.offset));
      rec.forEach(function (h) { out.push(h); });
      out.push(c.nameBytes);
    });
    var cdSize = out.size - cdStart;

    var eocd = [];
    eocd.push(u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdSize), u32(cdStart), u16(0));
    eocd.forEach(function (h) { out.push(h); });

    var total = new Uint8Array(out.size);
    var pos = 0;
    out.parts.forEach(function (p) { total.set(p, pos); pos += p.length; });
    return total;
  }

  var ZIP = { zip: zip, crc32: crc32, utf8: utf8 };
  global.KDZIP = ZIP;
  if (typeof module !== 'undefined' && module.exports) module.exports = ZIP;
})(typeof globalThis !== 'undefined' ? globalThis : this);

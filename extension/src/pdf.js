/* 极简 JPEG → PDF 生成器（零依赖）
 * 只做一件事：把若干张 JPEG 按顺序排成一页一张的 PDF。
 * PDF 的 /DCTDecode 滤镜可以直接内嵌 JPEG 原始字节，所以不需要解码/重编码。
 */
(function (global) {
  'use strict';

  function toLatin1(str) {
    var arr = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
    return arr;
  }

  // 读 JPEG 的宽高与通道数
  function jpegInfo(bytes) {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('不是 JPEG');
    var i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      var len = (bytes[i + 2] << 8) | bytes[i + 3];
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        var h = (bytes[i + 5] << 8) | bytes[i + 6];
        var w = (bytes[i + 7] << 8) | bytes[i + 8];
        var comps = bytes[i + 9];
        return { width: w, height: h, components: comps };
      }
      i += 2 + len;
    }
    throw new Error('找不到 SOF 段');
  }

  // PDF 文本串：UTF-16BE + BOM，写成十六进制串，中文标题才不会乱码
  function pdfTextString(str) {
    var hex = 'FEFF';
    for (var i = 0; i < str.length; i++) {
      hex += ('0000' + str.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    }
    return '<' + hex + '>';
  }

  function PdfBuilder() {
    this.chunks = [];
    this.length = 0;
    this.offsets = {};   // objNum -> byte offset
    this.next = 1;
  }

  PdfBuilder.prototype.push = function (data) {
    var bytes = typeof data === 'string' ? toLatin1(data) : data;
    this.chunks.push(bytes);
    this.length += bytes.length;
  };

  PdfBuilder.prototype.beginObj = function (num) {
    this.offsets[num] = this.length;
    this.push(num + ' 0 obj\n');
  };

  PdfBuilder.prototype.endObj = function () { this.push('endobj\n'); };

  PdfBuilder.prototype.finish = function (rootNum, infoNum) {
    var xrefStart = this.length;
    var maxObj = this.next - 1;
    var xref = 'xref\n0 ' + (maxObj + 1) + '\n0000000000 65535 f \n';
    for (var n = 1; n <= maxObj; n++) {
      var off = this.offsets[n] || 0;
      xref += ('0000000000' + off).slice(-10) + ' 00000 n \n';
    }
    this.push(xref);
    this.push('trailer\n<< /Size ' + (maxObj + 1) + ' /Root ' + rootNum + ' 0 R' +
      (infoNum ? ' /Info ' + infoNum + ' 0 R' : '') + ' >>\nstartxref\n' +
      xrefStart + '\n%%EOF\n');

    var total = new Uint8Array(this.length);
    var pos = 0;
    for (var i = 0; i < this.chunks.length; i++) { total.set(this.chunks[i], pos); pos += this.chunks[i].length; }
    return total;
  };

  /**
   * images: [{ data: Uint8Array, name?: string }]
   * opts: { title, author, pageWidth, pageHeight, margin }
   */
  function imagesToPdf(images, opts) {
    opts = opts || {};
    var PW = opts.pageWidth || 595.28;   // A4 pt
    var PH = opts.pageHeight || 841.89;
    var M = opts.margin === undefined ? 18 : opts.margin;

    var b = new PdfBuilder();
    b.push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');

    var catalogNum = 1, pagesNum = 2, infoNum = 3;
    var kids = [];
    var objNum = 4;

    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      var bytes = img.data;
      var info = jpegInfo(bytes);

      var availW = PW - M * 2, availH = PH - M * 2;
      var scale = Math.min(availW / info.width, availH / info.height);
      var w = info.width * scale, h = info.height * scale;
      var x = (PW - w) / 2, y = (PH - h) / 2;

      var pageObj = objNum++, contentObj = objNum++, imgObj = objNum++;
      kids.push(pageObj + ' 0 R');

      var cs = info.components === 1 ? '/DeviceGray' : (info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB');

      var content = 'q\n' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm\n/Im0 Do\nQ\n';

      b.beginObj(pageObj);
      b.push('<< /Type /Page /Parent ' + pagesNum + ' 0 R /MediaBox [0 0 ' + PW.toFixed(2) + ' ' + PH.toFixed(2) + ']' +
        ' /Resources << /XObject << /Im0 ' + imgObj + ' 0 R >> /ProcSet [/PDF /ImageC] >>' +
        ' /Contents ' + contentObj + ' 0 R >>\n');
      b.endObj();

      b.beginObj(contentObj);
      b.push('<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\n');
      b.endObj();

      b.beginObj(imgObj);
      b.push('<< /Type /XObject /Subtype /Image /Width ' + info.width + ' /Height ' + info.height +
        ' /ColorSpace ' + cs + ' /BitsPerComponent 8 /Filter /DCTDecode' +
        ' /Length ' + bytes.length + ' >>\nstream\n');
      b.push(bytes);
      b.push('\nendstream\n');
      b.endObj();
    }

    b.beginObj(pagesNum);
    b.push('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + kids.length + ' >>\n');
    b.endObj();

    b.beginObj(catalogNum);
    b.push('<< /Type /Catalog /Pages ' + pagesNum + ' 0 R >>\n');
    b.endObj();

    var title = pdfTextString(opts.title || '快对答案');
    b.beginObj(infoNum);
    b.push('<< /Title ' + title + ' /Producer (KuaiduiDownloader) >>\n');
    b.endObj();

    b.next = objNum;
    return b.finish(catalogNum, infoNum);
  }

  var PDF = { imagesToPdf: imagesToPdf, jpegInfo: jpegInfo };
  global.KDPDF = PDF;
  if (typeof module !== 'undefined' && module.exports) module.exports = PDF;
})(typeof globalThis !== 'undefined' ? globalThis : this);

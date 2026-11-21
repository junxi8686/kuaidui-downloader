/* 快对 App 里那套「变体 DES」
 *
 * 结论（对着 libbaseutil.so 的实测向量反推）：
 *   算法本体是标准 DES，但**输入和输出的每个字节都按位反序**（LSB 当 MSB 用）。
 *     密文 = bitrev_byte( DES_std( bitrev_byte(明文), 密钥 ) )
 *   验证向量：明文 "ABCDEFGH"、全零密钥 → d303b8ba2d8bd76e
 *   （标准 DES 给 d3e6f4483c0ceba9，位反序后正好是上面那个）
 *
 * 表（PC1 / S1 等）在 .so 的 .rodata 里就是标准 DES 表，只是存成 int32。
 */
(function (global) {
  'use strict';

  var IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,
            62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
            57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,
            61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
  var FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,
            38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
            36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,
            34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
  var E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,
           16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
  var P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,
           2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
  var PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,
             60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,
             29,21,13,5,28,20,12,4];
  var PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
             41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
  var SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
  var SBOX = [
    [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
     4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
    [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
     0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
    [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
     13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
    [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
     10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
    [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
     4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
    [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
     9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
    [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
     1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
    [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,
     7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11]
  ];

  function bytesToBits(bytes) {
    var bits = new Array(bytes.length * 8);
    for (var i = 0; i < bytes.length; i++) {
      for (var b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    }
    return bits;
  }

  function bitsToBytes(bits) {
    var out = new Uint8Array(bits.length / 8);
    for (var i = 0; i < out.length; i++) {
      var v = 0;
      for (var b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
      out[i] = v;
    }
    return out;
  }

  function permute(bits, table) {
    var out = new Array(table.length);
    for (var i = 0; i < table.length; i++) out[i] = bits[table[i] - 1];
    return out;
  }

  function keySchedule(keyBytes) {
    var keyBits = bytesToBits(keyBytes);
    var cd = permute(keyBits, PC1);
    var subkeys = [];
    for (var r = 0; r < 16; r++) {
      var s = SHIFTS[r];
      cd = cd.slice(s, 28).concat(cd.slice(0, s)).concat(cd.slice(28 + s).concat(cd.slice(28, 28 + s)));
      subkeys.push(permute(cd, PC2));
    }
    return subkeys;
  }

  function feistel(right, subkey) {
    var expanded = permute(right, E);
    // 关键：和子密钥异或（之前漏了这一步，全零密钥时才看不出来）
    for (var k = 0; k < 48; k++) expanded[k] ^= subkey[k];
    var out = new Array(32);
    for (var i = 0; i < 8; i++) {
      var row = (expanded[i * 6] << 1) | expanded[i * 6 + 5];
      var col = (expanded[i * 6 + 1] << 3) | (expanded[i * 6 + 2] << 2) |
                (expanded[i * 6 + 3] << 1) | expanded[i * 6 + 4];
      var v = SBOX[i][row * 16 + col];
      out[i * 4] = (v >> 3) & 1;
      out[i * 4 + 1] = (v >> 2) & 1;
      out[i * 4 + 2] = (v >> 1) & 1;
      out[i * 4 + 3] = v & 1;
    }
    return permute(out, P);
  }

  function desBlock(blockBytes, subkeys) {
    var bits = permute(bytesToBits(blockBytes), IP);
    var left = bits.slice(0, 32), right = bits.slice(32);
    for (var r = 0; r < 16; r++) {
      var f = feistel(right, subkeys[r]);
      var next = new Array(32);
      for (var i = 0; i < 32; i++) next[i] = left[i] ^ f[i];
      left = right;
      right = next;
    }
    return bitsToBytes(permute(right.concat(left), FP));
  }

  function bitrevByte(b) {
    var v = 0;
    for (var i = 0; i < 8; i++) v |= ((b >> i) & 1) << (7 - i);
    return v & 0xFF;
  }

  function bitrev(bytes) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bitrevByte(bytes[i]);
    return out;
  }

  /** 标准 DES 单块（8 字节） */
  function desStdBlock(block, key) {
    return desBlock(block, keySchedule(key));
  }

  /** 快对 .so 里那套：输入/输出按位反序 */
  function kdBlock(block, key) {
    return bitrev(desBlock(bitrev(block), keySchedule(key)));
  }

  /** ECB，PKCS5 填充；返回密文字节 */
  function encryptECB(data, key) {
    var pad = 8 - (data.length % 8);
    var buf = new Uint8Array(data.length + pad);
    buf.set(data);
    for (var i = data.length; i < buf.length; i++) buf[i] = pad;
    var subkeys = keySchedule(key);
    var out = new Uint8Array(buf.length);
    for (var off = 0; off < buf.length; off += 8) {
      out.set(bitrev(desBlock(bitrev(buf.subarray(off, off + 8)), subkeys)), off);
    }
    return out;
  }

  /** signA 的最终编码：每字节拆两个 nibble，各反转 4 位，再各写 2 位 hex */
  function signaEncode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var hi = (bytes[i] >> 4) & 0xF, lo = bytes[i] & 0xF;
      var rh = bitrevByte(hi << 4) >> 4, rl = bitrevByte(lo << 4) >> 4;
      out += ('0' + rh.toString(16)).slice(-2) + ('0' + rl.toString(16)).slice(-2);
    }
    return out;
  }

  var API = {
    desBlock: desStdBlock,
    kdBlock: kdBlock,
    encryptECB: encryptECB,
    signaEncode: signaEncode,
    bitrev: bitrev,
    _keySchedule: keySchedule,
    _desBlockWithSubkeys: desBlock
  };
  global.kdDes = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);

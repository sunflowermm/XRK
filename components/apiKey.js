const Obfuscator = {
  _chunks: [
    [0x4d ^ 0x47, 0x8f ^ 0x47, 0x92 ^ 0x47, 0x5e ^ 0x47],
    [0x3a ^ 0x47, 0xb4 ^ 0x47, 0xbc ^ 0x47, 0x80 ^ 0x47],
    [0xfb ^ 0x47, 0xb5 ^ 0x47, 0x2f ^ 0x47, 0x71 ^ 0x47],
    [0xae ^ 0x47, 0xa0 ^ 0x47, 0xf6 ^ 0x47, 0x73 ^ 0x47]
  ],

  _xorDecode(arr, mask) {
    return arr.map((b) => b ^ mask);
  },

  _toHexString(byteArr) {
    return byteArr
      .map(b => {
        let s = b.toString(16);
        return s.length < 2 ? '0' + s : s;
      })
      .join('');
  },

  _toB64(str) {
    return Buffer.from(str, 'utf8').toString('base64');
  },

  _fromB64(str) {
    return Buffer.from(str, 'base64').toString('utf8');
  },

  _reverse(str) {
    return str.split('').reverse().join('');
  }
};

export function getApiKey() {
  let byteArr = [];
  for (let i = 0; i < Obfuscator._chunks.length; i++) {
    const chunk = Obfuscator._chunks[i];
    const decoded = Obfuscator._xorDecode(chunk, 0x47);
    byteArr = byteArr.concat(decoded);
  }
  let hexKey = Obfuscator._toHexString(byteArr);
  const step1 = Obfuscator._toB64(hexKey);
  const step2 = Obfuscator._reverse(step1);
  const step3 = Obfuscator._fromB64(Obfuscator._reverse(step2));
  return step3;
}
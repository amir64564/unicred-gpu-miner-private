/* CPU reference of unicred_cuda.cu mine_kernel + keccak_f_u32.
 * Build: gcc -O3 -std=c11 unicred_cpu_ref.c -o unicred_cpu_ref
 * Usage: ./unicred_cpu_ref <digest|search> ... (see main)
 * Verifies midstate+nonce XOR matches JS keccak_core / on-chain abi.encode digest.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static uint32_t bswap32(uint32_t v) {
  return ((v & 0xffu) << 24) | ((v & 0xff00u) << 8) | ((v >> 8) & 0xff00u) | (v >> 24);
}

static void keccak_f_u32(uint32_t s[50]) {
  static const uint32_t RC_LO[24] = {
    0x00000001,0x00008082,0x0000808a,0x80008000,0x0000808b,0x80000001,0x80008081,0x00008009,
    0x0000008a,0x00000088,0x80008009,0x8000000a,0x8000808b,0x0000008b,0x00008089,0x00008003,
    0x00008002,0x00000080,0x0000800a,0x8000000a,0x80008081,0x00008080,0x80000001,0x80008008
  };
  static const uint32_t RC_HI[24] = {
    0x00000000,0x00000000,0x80000000,0x80000000,0x00000000,0x00000000,0x80000000,0x80000000,
    0x00000000,0x00000000,0x00000000,0x00000000,0x00000000,0x80000000,0x80000000,0x80000000,
    0x80000000,0x80000000,0x00000000,0x80000000,0x80000000,0x80000000,0x00000000,0x80000000
  };
  static const int ROT[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
  int pi[25];
  for (int x = 0; x < 5; x++) for (int y = 0; y < 5; y++)
    pi[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

  uint32_t B[50], C[10];
  for (int round = 0; round < 24; round++) {
    for (int x = 0; x < 5; x++) {
      C[2*x]   = s[2*x]   ^ s[2*x+10] ^ s[2*x+20] ^ s[2*x+30] ^ s[2*x+40];
      C[2*x+1] = s[2*x+1] ^ s[2*x+11] ^ s[2*x+21] ^ s[2*x+31] ^ s[2*x+41];
    }
    for (int x = 0; x < 5; x++) {
      int x1 = (x + 1) % 5, x4 = (x + 4) % 5;
      uint32_t lo = C[2*x1], hi = C[2*x1+1];
      uint32_t dlo = C[2*x4]   ^ ((lo << 1) | (hi >> 31));
      uint32_t dhi = C[2*x4+1] ^ ((hi << 1) | (lo >> 31));
      for (int y = 0; y < 25; y += 5) {
        s[2*(x+y)]   ^= dlo;
        s[2*(x+y)+1] ^= dhi;
      }
    }
    for (int i = 0; i < 25; i++) {
      uint32_t lo = s[2*i], hi = s[2*i+1];
      int r = ROT[i], j = pi[i];
      if (r == 0) { B[2*j] = lo; B[2*j+1] = hi; }
      else if (r < 32) {
        B[2*j]   = (lo << r) | (hi >> (32 - r));
        B[2*j+1] = (hi << r) | (lo >> (32 - r));
      } else if (r == 32) { B[2*j] = hi; B[2*j+1] = lo; }
      else {
        int q = r - 32;
        B[2*j]   = (hi << q) | (lo >> (32 - q));
        B[2*j+1] = (lo << q) | (hi >> (32 - q));
      }
    }
    for (int y = 0; y < 25; y += 5) {
      for (int x = 0; x < 5; x++) {
        int a = 2*(x+y), b = 2*(((x+1)%5)+y), c = 2*(((x+2)%5)+y);
        s[a]   = B[a]   ^ (~B[b]   & B[c]);
        s[a+1] = B[a+1] ^ (~B[b+1] & B[c+1]);
      }
    }
    s[0] ^= RC_LO[round];
    s[1] ^= RC_HI[round];
  }
}

static void digest_hex(const uint32_t base[50], uint32_t hiWord, uint32_t ctr, char out[67]) {
  uint32_t s[50];
  for (int i = 0; i < 50; i++) s[i] = base[i];
  s[12] ^= bswap32(hiWord);
  s[13] ^= bswap32(ctr);
  keccak_f_u32(s);
  out[0] = '0'; out[1] = 'x';
  int p = 2;
  for (int i = 0; i < 4; i++) {
    uint32_t lo = s[2*i], hi = s[2*i+1];
    for (int half = 0; half < 2; half++) {
      uint32_t v = half ? hi : lo;
      for (int k = 0; k < 4; k++) {
        unsigned b = (v >> (8*k)) & 0xff;
        sprintf(out + p, "%02x", b);
        p += 2;
      }
    }
  }
  out[66] = 0;
}

/* Same prefilter as fixed CUDA/JS: accept equal top-64 for full verify. */
static int below_target(uint32_t top, uint32_t nxt, uint32_t tHi, uint32_t tLo) {
  return top < tHi || (top == tHi && nxt <= tLo);
}

static int search(const uint32_t base[50], uint32_t hiWord, uint32_t start, uint32_t count,
                  uint32_t tHi, uint32_t tLo) {
  uint32_t hiSw = bswap32(hiWord);
  for (uint32_t n = 0; n < count; n++) {
    uint32_t ctr = start + n;
    uint32_t s[50];
    for (int i = 0; i < 50; i++) s[i] = base[i];
    s[12] ^= hiSw;
    s[13] ^= bswap32(ctr);
    keccak_f_u32(s);
    uint32_t top = bswap32(s[0]);
    uint32_t nxt = bswap32(s[1]);
    if (below_target(top, nxt, tHi, tLo)) return (int)ctr;
  }
  return -1;
}

static int read_base(uint32_t base[50]) {
  for (int i = 0; i < 50; i++) {
    unsigned long v;
    if (scanf("%lu", &v) != 1) return 0;
    base[i] = (uint32_t)v;
  }
  return 1;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s digest <hi> <ctr>  OR  %s search <hi> <start> <count> <tHi> <tLo>\n"
                    "base[50] unsigned decimals on stdin\n", argv[0], argv[0]);
    return 2;
  }
  uint32_t base[50];
  if (!read_base(base)) { fprintf(stderr, "need 50 base words\n"); return 2; }
  if (strcmp(argv[1], "digest") == 0) {
    if (argc < 4) return 2;
    uint32_t hi = (uint32_t)strtoul(argv[2], NULL, 0);
    uint32_t ctr = (uint32_t)strtoul(argv[3], NULL, 0);
    char hex[67];
    digest_hex(base, hi, ctr, hex);
    puts(hex);
    return 0;
  }
  if (strcmp(argv[1], "search") == 0) {
    if (argc < 7) return 2;
    uint32_t hi = (uint32_t)strtoul(argv[2], NULL, 0);
    uint32_t start = (uint32_t)strtoul(argv[3], NULL, 0);
    uint32_t count = (uint32_t)strtoul(argv[4], NULL, 0);
    uint32_t tHi = (uint32_t)strtoul(argv[5], NULL, 0);
    uint32_t tLo = (uint32_t)strtoul(argv[6], NULL, 0);
    printf("%d\n", search(base, hi, start, count, tHi, tLo));
    return 0;
  }
  return 2;
}

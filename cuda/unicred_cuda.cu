// UNICRED CUDA miner — keccak-f[1600] midstate, 2nd block only per nonce.
// JSON-lines protocol on stdin/stdout (see mine.mjs CudaPool).
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <cuda_runtime.h>

static __device__ __forceinline__ uint32_t bswap32(uint32_t v) {
  return __byte_perm(v, 0, 0x0123);
}

// Compact keccak-f[1600] on 25x u64 lanes stored as 50 u32 (lo,hi).
__device__ void keccak_f_u32(uint32_t s[50]) {
  const uint32_t RC_LO[24] = {
    0x00000001,0x00008082,0x0000808a,0x80008000,0x0000808b,0x80000001,0x80008081,0x00008009,
    0x0000008a,0x00000088,0x80008009,0x8000000a,0x8000808b,0x0000008b,0x00008089,0x00008003,
    0x00008002,0x00000080,0x0000800a,0x8000000a,0x80008081,0x00008080,0x80000001,0x80008008
  };
  const uint32_t RC_HI[24] = {
    0x00000000,0x00000000,0x80000000,0x80000000,0x00000000,0x00000000,0x80000000,0x80000000,
    0x00000000,0x00000000,0x00000000,0x00000000,0x00000000,0x80000000,0x80000000,0x80000000,
    0x80000000,0x80000000,0x00000000,0x80000000,0x80000000,0x80000000,0x00000000,0x80000000
  };
  const int ROT[25] = {0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
  // PI dest = y + 5*((2x+3y)%5) — match lib/keccak_core.mjs
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

__global__ void mine_kernel(
  const uint32_t* __restrict__ base, // 50 u32 mid^tail
  uint32_t hiSw, uint32_t ctrBase,
  uint32_t tHi, uint32_t tLo,
  uint32_t* __restrict__ out // [foundFlag, ctr]
) {
  uint32_t ctr = ctrBase + blockIdx.x * blockDim.x + threadIdx.x;
  uint32_t s[50];
  #pragma unroll
  for (int i = 0; i < 50; i++) s[i] = base[i];
  s[12] ^= hiSw;
  s[13] ^= bswap32(ctr);
  keccak_f_u32(s);
  uint32_t top = bswap32(s[0]);
  uint32_t nxt = bswap32(s[1]);
  if (top < tHi || (top == tHi && nxt <= tLo)) {
    if (atomicCAS(out, 0, 1) == 0) out[1] = ctr;
  }
}

struct Job {
  uint32_t base[50];
  uint32_t tHi = 0, tLo = 0, hiWord = 0;
  uint64_t jobId = 0;
  bool valid = false;
};

static std::mutex g_mu;
static Job g_job;
static std::atomic<bool> g_run{true};

static uint32_t bswap_host(uint32_t v) {
  return ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24);
}

// Minimal JSON number / array extractors (avoid heavy deps)
static bool parse_job(const std::string& line, Job& j) {
  // Expected: {"cmd":"job","jobId":N,"base":[50 nums],"tHi":N,"tLo":N,"hiWord":N}
  auto find_num = [&](const char* key) -> uint64_t {
    auto p = line.find(key);
    if (p == std::string::npos) return 0;
    p = line.find(':', p);
    if (p == std::string::npos) return 0;
    return strtoull(line.c_str() + p + 1, nullptr, 10);
  };
  auto p = line.find("\"base\":[");
  if (p == std::string::npos) return false;
  p = line.find('[', p);
  int idx = 0;
  const char* s = line.c_str() + p + 1;
  while (*s && idx < 50) {
    while (*s == ' ' || *s == ',') s++;
    if (*s == ']') break;
    j.base[idx++] = (uint32_t)strtoul(s, (char**)&s, 10);
  }
  if (idx != 50) return false;
  j.jobId = find_num("\"jobId\"");
  j.tHi = (uint32_t)find_num("\"tHi\"");
  j.tLo = (uint32_t)find_num("\"tLo\"");
  j.hiWord = (uint32_t)find_num("\"hiWord\"");
  j.valid = true;
  return true;
}

void gpu_loop(int dev, int nDev) {
  cudaSetDevice(dev);
  uint32_t *d_base = nullptr, *d_out = nullptr;
  cudaMalloc(&d_base, 50 * sizeof(uint32_t));
  cudaMalloc(&d_out, 2 * sizeof(uint32_t));
  const int WG = 256;
  int groups = 4096;
  uint32_t ctr = 0;
  uint64_t lastJob = 0;
  uint32_t myHi = 0;
  uint32_t hiSw = 0;

  while (g_run.load()) {
    Job job;
    {
      std::lock_guard<std::mutex> lk(g_mu);
      job = g_job;
    }
    if (!job.valid) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }
    if (job.jobId != lastJob) {
      cudaMemcpy(d_base, job.base, 50 * sizeof(uint32_t), cudaMemcpyHostToDevice);
      // Unique hiWord per GPU so devices never search the same nonce space.
      myHi = job.hiWord + (uint32_t)dev;
      hiSw = bswap_host(myHi);
      ctr = 0;
      lastJob = job.jobId;
      groups = 4096;
    }
    uint32_t zero[2] = {0, 0};
    cudaMemcpy(d_out, zero, sizeof(zero), cudaMemcpyHostToDevice);
    auto t0 = std::chrono::steady_clock::now();
    mine_kernel<<<groups, WG>>>(d_base, hiSw, ctr, job.tHi, job.tLo, d_out);
    cudaDeviceSynchronize();
    auto t1 = std::chrono::steady_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    uint32_t out[2];
    cudaMemcpy(out, d_out, sizeof(out), cudaMemcpyDeviceToHost);
    uint64_t batch = (uint64_t)groups * WG;
    double hps = (ms > 0) ? (batch * 1000.0 / ms) : 0;
    printf("{\"event\":\"hashrate\",\"gpu\":%d,\"hps\":%.0f,\"batch\":%llu}\n", dev, hps, (unsigned long long)batch);
    fflush(stdout);
    if (out[0]) {
      printf("{\"event\":\"found\",\"jobId\":%llu,\"hiWord\":%u,\"ctr\":%u,\"gpu\":%d}\n",
             (unsigned long long)job.jobId, myHi, out[1], dev);
      fflush(stdout);
    }
    uint32_t prevCtr = ctr;
    ctr += (uint32_t)batch;
    if (ctr < prevCtr) { // uint32 wrap — advance hiWord, keep GPUs disjoint
      myHi += (uint32_t)(nDev > 0 ? nDev : 1);
      hiSw = bswap_host(myHi);
    }
    if (ms < 25 && groups < 65535) groups = groups * 2 > 65535 ? 65535 : groups * 2;
    else if (ms > 80 && groups > 64) groups /= 2;
  }
  cudaFree(d_base);
  cudaFree(d_out);
}

int main(int argc, char** argv) {
  (void)argc; (void)argv;
  int n = 0;
  cudaGetDeviceCount(&n);
  if (n <= 0) {
    fprintf(stderr, "no CUDA devices\n");
    return 1;
  }
  printf("{\"event\":\"ready\",\"gpus\":%d}\n", n);
  fflush(stdout);
  std::vector<std::thread> threads;
  for (int i = 0; i < n; i++) threads.emplace_back(gpu_loop, i, n);

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.find("\"cmd\":\"stop\"") != std::string::npos) break;
    if (line.find("\"cmd\":\"idle\"") != std::string::npos) {
      std::lock_guard<std::mutex> lk(g_mu);
      g_job.valid = false;
      continue;
    }
    if (line.find("\"cmd\":\"job\"") != std::string::npos) {
      Job j;
      if (parse_job(line, j)) {
        std::lock_guard<std::mutex> lk(g_mu);
        g_job = j;
      }
    }
  }
  g_run.store(false);
  for (auto& t : threads) t.join();
  return 0;
}

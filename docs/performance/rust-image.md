# 선택적 Rust 이미지 계산: 근거, 계약과 재현

이미지의 무거운 scanline/RGB 복원·dHash와 실측 작업량 이상 colorStats만 Rust로 계산한다. 기본 설치는 기존 JavaScript를 사용하며, 사용자가 별도 빌드한 경우에만 native를 선택한다. PNG 헤더/청크 파싱·Node zlib inflate, 작은 색상 통계, hammingHex, screenshot 객체 캐시와 나머지 QA 파이프라인은 기존 동작을 유지한다.

## 요청과 기준

공개 코드만을 대상으로 정리한 요청: “원본과 같은 출력을 먼저 확인하고 Rust와 원본을 단일/다중/공유 입력에서 실제 비교한다. 실측 근거가 있는 부분만 앱에 연결하고, 별도 브랜치에 커밋하여 상세한 draft PR을 만든다.” 개인 이미지·기기·자격 증명·호스트 경로는 사용하지 않았다.

- 기준/main SHA: `86d5685651ede2bec57000c9b36e32d4ac5ea217`.
- 런타임 구현 SHA: `468d34c3cde735c7a5c9d2a54297ebc5cd52e206`. 이후 문서 커밋은 실행 코드를 바꾸지 않는다.
- 측정 당시 checkout HEAD는 기준 SHA이고 구현은 작업 트리 상태였다. `image-integration-evidence.json`의 7개 런타임 파일 SHA256이 위 구현 커밋의 동일 파일과 일치함을 확인했다. 이전 독립 실험과 이번 production 경계의 수치를 섞지 않는다.
- `test/helpers/image-reference.ts`는 기준의 `src/runner/image.ts`를 byte 그대로 보관한 테스트 전용 원본이다. production은 이 파일을 import하지 않는다.

## 코드와 설치 경계

| 경로 | 처리 |
|---|---|
| `src/runner/image.ts` | 기존 PNG parser/inflate 후 native `decodeRgb` 선택. dHash는 유효한 RGB에 native 선택. colorStats는 샘플 4,800개 이상일 때 선택. 원래 JS 본문은 fallback으로 유지 |
| `native/image/src/lib.rs` | 필터 0–4 scanline 복원, RGB/high-byte 추출, 원래 luma 누적·hash packing·color bucket 집계 |
| `src/runner/image-native.ts` | `auto/js/native` 선택, source/API/platform/architecture/binary hash 확인, FFI 입력 검증과 shared bytes snapshot |
| `src/runner/engine.ts` | 원래 pngHash를 image.ts에서 import. 함수 본문과 WeakMap의 객체 identity hit/null 캐시 의미는 그대로 유지 |
| `scripts/build-image-native.mjs` | 사용자가 요청할 때만 Cargo `--locked --release`; 로컬 `.tools/`에 플랫폼별 binary/manifest 기록. 기존 loaded inode를 truncate하지 않고 atomic rename |

루트 npm 의존성과 `package-lock.json`은 바꾸지 않았다. 새 npm install/postinstall/prepare 훅, 자동 다운로드, CI workflow는 없다. Rust 의존성은 `native/image/Cargo.toml`과 Cargo.lock 안에만 둔다(NAPI-RS 3.16.1, napi-derive 3.7.0, napi-build 2.6.0). 빌드 중 source가 바뀌면 설치를 거부한다.

기본 `auto`는 artifact 두 파일이 모두 없을 때 JS를 선택한다. `js`는 명시적으로 기존 구현을 선택한다. `native`는 모듈 부재도 오류로 취급한다. 모듈/manifest 일부 누락, stale source, 잘못된 API/OS/CPU/hash, load 또는 계산 오류는 catch하여 조용히 JS로 전환하지 않는다. `imageBackendInfo()`로 선택된 capability를 확인한다. 선택은 각 process/worker의 모듈 수명 동안 고정되므로 빌드·재빌드 뒤에는 QA 프로세스를 다시 시작한다.

Linux x64에서 빌드·실행했다. build script에 darwin/win32 library 이름과 x64/arm64 설정은 있지만 해당 플랫폼의 빌드·실행은 미검증이다. 각 플랫폼에서 직접 빌드해야 하며 prebuilt를 배포하지 않는다. 다른 OS/CPU에는 기본 JS가 남는다.

## 동일성 및 스레드 계약

- 기존 public `decodePng`/dHash/hammingHex/colorStats의 반환 의미를 유지한다. PNG 예외도 헤더 파싱·inflate가 기존 JS에 남아 있으므로 원래 경로를 지난다.
- non-interlaced 8/16-bit grey/RGB/grey+alpha/RGBA와 8-bit palette, 필터 0–4를 원본과 같이 처리한다. alpha 제거, 16-bit 상위 byte, 없는 palette 색상 0, CRC 미검사, 낮은 bit depth/interlace 거부도 그대로다. 전체 PNG conformance를 새로 주장하지 않는다.
- dHash의 2픽셀 간격, 9×8 luma 셀, IEEE754 연산 순서, counts wrap, MSB 우선 64bit/hex packing을 유지한다. colorStats의 4픽셀 간격·5bit bucket과 red 경계를 유지한다.
- 내부 u32/RGB 길이 조건을 만족하지 않는 Raster는 기존 JS 경로로 보낸다. native 직접 호출도 짧은 RGB를 검증한다. 임의 메모리 고갈 상황의 예외 동일성까지 주장하지 않는다.
- Node에는 CPython GIL이 없다. 함수는 동기이며 자기 worker의 이벤트 루프를 막는다. Rust 계산 사이 전역 직렬화 lock은 없다. 메인 스레드 async API라고 주장하지 않는다.
- 일반 ArrayBuffer RGB/raw는 동기 호출 동안 빌리고 Rust에 저장하지 않는다. SharedArrayBuffer RGB/palette는 **JS에서 먼저 private Uint8Array로 복사**한 후 Rust가 빌린다. 다른 JS worker의 쓰기와 Rust slice의 경합을 피한다. 따라서 임의 shared RGB에 zero-copy 성능을 주장하지 않는다. PNG parsing/inflate는 기존 Node 경로이고, native의 raw는 각 worker가 얻은 private inflate 결과다.

## 작은 색상 입력을 JS에 남긴 이유

이전 독립 실험에서 1×1 colorStats는 원본 146.784ns, 직접 Rust 3,047.333ns(p50 batch 평균)로 20.76배 느렸다. Rust의 고정 `[u32;32768]`(128KiB) 초기화와 원본 Map 항목 하나의 차이가 코드상 설명이다. 초기화만 따로 분리 측정한 주장은 아니다.

4,800 sampled pixels는 이전 화면 실험에서 가장 작은 320×240 입력의 `ceil(width/4)*ceil(height/4)`다. 최적 crossover를 추정한 magic threshold가 아니라 **측정된 작업량의 보수적 하한**으로 쓴다. 그 미만과 u32 counter 범위를 넘는 작업은 JS다. 모든 종횡비/색상 분포에서 이득이라는 보장은 없다.

최종 production 선택 경계를 거친 작은 입력의 7batch×12,000회 재측정:

| 크기 | 원본 p50 / p95 ns | 통합 p50 / p95 ns |
|---|---:|---:|
| 1x1 | 107.13 / 147.18 | 115.29 / 276.80 |
| 16x16 | 608.68 / 942.65 | 596.37 / 945.34 |
| 64x64 | 7286.03 / 7564.58 | 7272.34 / 7719.44 |

작은 경로에는 선택 판단 비용과 JIT/GC 변동이 남는다. 직접 Rust의 약21배 퇴행을 피했다는 뜻이며, 작은 입력까지 빨라졌다는 주장은 아니다.

## 검증

| 검사 | 결과 |
|---|---|
| 변경 전 기준 `npm test` | 585 pass |
| 최종 native `npm test` | 608 pass, 0 skip |
| 실제 artifact 부재, auto `npm test` | 607 pass, 직접 native 입력 검사 1개 의도한 skip |
| native `npm run test:image` | 1,737 equality checks pass |
| 실제 artifact 부재, auto `npm run test:image` | 1,737 equality checks pass |
| `npm run typecheck` | pass |
| release build / rustfmt check / `git diff --check` | pass |
| atomic rebuild 후 native loader/공유 snapshot/cache 검사 | 23 pass |

기존 테스트의 assertion을 약화하거나 삭제하지 않았다. 23개 새 단위 테스트는 capability 부재/명시 JS/필수 native/잘못된 설정/부분 설치/stale source·platform·arch·API/checksum/load/실행 오류, 작은 색상 라우팅, 비정상 Raster의 JS 유지, 실 PNG 출력, 객체 identity 및 null 캐시, SAB snapshot/일반 backing 무복사를 검증한다.

동등성 스크립트는 기준으로 먼저 통과했던 frozen oracle SHA256을 유지하며 60개 PNG의 width/height/모든 RGB byte, dHash 문자열, 두 색상 비율, hamming 결과/잘못된 hex 예외(name/code/message)를 비교한다. 합성 PNG108개, PNG 오류/호환 사례24개, 추가 손상/truncation451개, 빈/작은/무작위 Raster 및 4 worker×30회 공유 backing 반복을 포함한다. 최종 속도 batch도 측정 시간 밖에서 원본의 모든 반환 필드를 대조한다.

기존 model 성능 assertion도 full suite 안에서 통과했지만, 그것은 JS 기준 검사이며 model/XML의 Rust 개선 실측이 아니다. 실기기·Mac UI·외부 유료 API는 실행하지 않았다.

## 최종 통합 실측 방법

- Node24.19.0, Rust/Cargo1.94.1, Linux x86_64 Intel Xeon Platinum8573C, quota `400000/100000`(4 CPU 상당), memory16GiB. Release/thin LTO/codegen-units1, fast-math 없이 빌드했다. 호스트에는5CPU가 보여도 quota는4다.
- 실제 fixture 3개: desktop `claim-en.png`1280×800(39,038B), Android easyway `launch.png`1080×2400(108,077B), iOS expo-go `launch.png`1206×2622(234,168B). input SHA256은 JSON evidence에 있다. 합성 입력은 앞선 선별 실험과 이번 작은 입력 재검사에만 사용했다.
- 입력/연산/조건마다 구현별7batch. 원본 calibration3회와 worker별 첫 batch 전5회 warmup. cold 호출 수는 원본에서 약100ms에 해당하도록 정하되 최소2회이며 양쪽에 같은 N을 사용한다. cache hit는 batch당500,000회다. 고정 seed41247로 원본/통합 순서를 interleave한다.
- p50/p95는 **worker별 batch elapsed/N 평균값**의 nearest-rank percentile이다. 1worker는7개 sample, 4worker는28개다. 개별 요청 지연의 p95가 아니다. 2회짜리 큰 PNG batch는 스케줄링 변동이 크므로 CSV의 min/max 처리량도 함께 보라.
- 처리량은 전체 완료 호출 수를 각 batch의 최초 worker 시작~최후 worker 종료 span 합으로 나눈 aggregate ops/s다. worker 생성, 사전 입력/identity 준비, warmup, 정답 검사와 명시 GC는 제외한다. 정상 결과 생성·FFI·필요한 내부 복사와 실행 중 GC는 포함한다.
- `pngHashCold`는 실제 production pngHash를 호출한다. 호출마다 같은 byte backing을 가리키는 **새 Uint8Array identity를 시간 밖에서 준비**하여 WeakMap miss를 만든다. baseline은 기존 cache 본문을 그대로 사용한다.
- `pngHashCached`는 양쪽 모두 같은 객체를 먼저 prime한 뒤 hit만 잰다. 캐시된 JS와 uncached native 계산을 비교하지 않는다. cached 결과에 Rust가 관여하지 않으며 개선을 기대하지 않는다.
- `decodeColorStats`는 health의 이미지 계산 경계(decode+stats), `decodeHashStats`는 이전 실험과 비교할 보조 합성 경계다. 전체 checkHealth/기기 관찰/QA 시간을 잰 것이 아니다. Rust decode RGB도 JS에 반환한 뒤 다음 native 함수를 부른다.
- 독립4worker는 별도 clone backing의 동일 PNG다. 공유4worker는 main이 한 번 채우고 실행 중 수정하지 않은 **동일 SAB PNG backing**이다. 두 경우 모두 기존 Buffer.concat IDAT copy/inflate/output 할당은 계산 안에 포함한다. direct shared RGB는 앞서 설명한 snapshot 비용을 가지며 이 PNG 경계 표로 그 별도 비용을 추정하지 않는다.

### 실제 cache miss: Android 1080×2400

| 조건 | 원본 p50 / p95 ms | 통합 p50 / p95 ms | 원본 → 통합 ops/s | 처리량 비율 |
|---|---:|---:|---:|---:|
| one | 52.30 / 53.36 | 26.82 / 27.78 | 19.14 → 37.15 | 1.94× |
| independent | 93.93 / 97.83 | 51.04 / 52.64 | 41.62 → 76.84 | 1.85× |
| shared | 74.56 / 93.86 | 30.27 / 52.97 | 44.54 → 77.36 | 1.74× |

### 이미 cache hit: 같은 입력과 객체 identity

| 조건 | 원본 p50 / p95 ns | 통합 p50 / p95 ns |
|---|---:|---:|
| one | 52.31 / 55.01 | 52.43 / 62.56 |
| independent | 79.97 / 102.94 | 82.30 / 113.88 |
| shared | 84.17 / 105.47 | 82.70 / 108.75 |

수십 ns짜리 hit는 호출 루프/JIT/스케줄링 영향이 크다. 표의 차이를 Rust의 이득으로 해석하지 않는다.

### 이미지 health 계산과 보조 decode+hash+stats

| 경계 | 조건 | 원본 p50 / p95 ms | 통합 p50 / p95 ms | 원본 → 통합 ops/s |
|---|---|---:|---:|---:|
| decodeColorStats | one | 48.83 / 49.98 | 26.26 / 27.62 | 20.56 → 37.61 |
| decodeColorStats | independent | 87.63 / 95.27 | 48.56 / 54.11 | 43.82 → 78.51 |
| decodeColorStats | shared | 87.84 / 91.83 | 48.47 / 49.92 | 44.49 → 79.79 |
| decodeHashStats | one | 52.41 / 60.26 | 27.68 / 28.32 | 18.61 → 36.08 |
| decodeHashStats | independent | 94.50 / 97.69 | 52.00 / 53.68 | 41.36 → 75.26 |
| decodeHashStats | shared | 93.20 / 97.53 | 51.37 / 52.94 | 41.27 → 75.68 |

3개 실제 입력×3worker 조건의 각각의 처리량 비교 범위는 cold pngHash **1.74–2.30×**, decode+stats **1.79–2.03×**, 보조 decode+hash+stats **1.80–1.96×**다. 이는 입력별/조건별 비율의 최소~최대이며 모든 입력을 합친 단일 속도나 앱 전체 개선율이 아니다. 전체72개 집계 행과 반복 처리량 min/max는 [CSV](image-integration-summary.csv)에 있다.

## 이전 독립 실험·메모리·남은 한계

기준86d5685의 독립 full-Rust decoder 실험은 실제 PNG3개+seed42 합성320×240/1280×720/1920×1080을 3worker 조건에서 비교해 decode+hash+stats 처리량1.77–2.59배를 얻었다(18개 개별 비교의 최소~최대). 그 결과로 후보를 골랐고, 이번에는 parser/inflate를 Node에 남긴 실제 production 경계를 따로 다시 측정했다.

이전 독립 모듈의 별도 fresh process18회(각 조건/구현3회)에서 대표 입력 peak RSS 중앙값은 원본/Rust가 1worker209.9/207.4MiB, 독립4worker565.0/524.2MiB, 공유4worker520.3/513.9MiB였다. 준비 후 baseline RSS와5ms sampled peak를 기록한 전체 Node+worker+native 수치이며 순간 peak를 놓칠 수 있다. allocator/GC 영향과 JS에 반환된 RGB 할당이 포함된다. **이 수치는 이번 통합 모듈의 메모리 측정이 아니다.** 확정적인 메모리 절감이나 Mac 값을 주장하지 않는다.

실제 엔진은 PNG identity cache와 장치/Appium/HTTP/OCR/LLM 대기 시간을 갖는다. cache hit에는 위 cold 이득이 적용되지 않고, 4worker도 quota·메모리·GC 때문에4배 확장되지 않는다. 전체 QA 또는 macOS/Windows 성능을 여기서 외삽하지 않는다.

XML/model/occlusion/sanitizer/문서 segmentation 등은 Rust 개선이 미측정이므로 변경하지 않는다. OCR은 이미 Swift/Apple Vision이고 SHA256은 Node native crypto이며 외부 대기는 wrapper 언어를 바꾼다고 줄어든다고 볼 근거가 없다. 다음 후보는 실제 CPU profile·호출 빈도·cache hit율과 FFI/직렬화 비용을 먼저 재야 한다.

## 재현

Node24+, Rust1.94+(검증1.94.1), C linker가 필요하다. 기본 사용에는 Rust가 필요 없다.

```sh
npm ci
APP_QA_IMAGE_BACKEND=js npm test
npm run build:image-native
APP_QA_IMAGE_BACKEND=native npm test
APP_QA_IMAGE_BACKEND=native npm run test:image
APP_QA_IMAGE_BACKEND=js npm run test:image
npm run typecheck
cargo fmt --manifest-path native/image/Cargo.toml -- --check
APP_QA_IMAGE_BACKEND=native node --expose-gc scripts/benchmark-image.mjs
```

쉘의 env 접두사는 Unix 예다. Windows에서는 동일 환경변수를 해당 쉘 방식으로 설정한다. `npm run bench:image`도 같은 script지만 GC 조건을 재현하려면 위 `--expose-gc` 명령을 쓴다.

큰 원시 기록은 runtime 배포나 커밋에 넣지 않는다. 재현 실행은 `.tools/native-image/evidence/`에 `integration-raw.json`, `integration-summary.{json,csv}`, `integration-small-{raw,summary}.json`, 환경/파일 hash와 동등성 결과를 기록한다. 이 문서와 함께 작은 공개 summary/evidence만 커밋한다. 원본 dependency lock과 테스트를 삭제하거나 성능 기준을 완화하지 않는다.

## 리뷰와 CI 범위

`must-avoid-check: pass`. architecture 스킬의 모든 must-avoid 항목을 diff와 대조했다. 계약/정책/판정/기기 action/재시도/잠금/정제/모델 권한 규칙은 바꾸지 않았고, 새 cross-module driver 의존성·전역 설치·외부 JS action·secret 전송·관찰 잘라내기를 추가하지 않았다. 기존 architecture/import cycle 검사도 full suite에서 통과했다.

위 pass는 cloud에서 직접 실행한 local check다. GitHub CI의 통과로 표시하지 않는다. PR head의 check/workflow 결과는 게시 후 PR 설명에서 별도로 기록하며, 미검증 플랫폼이나 확인할 수 없는 로그를 통과라고 추정하지 않는다. draft PR만 만들고 merge/deploy하지 않는다.

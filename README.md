# Multi-Cam Recorder — Thu thập dữ liệu tập chuẩn AI

Một máy **Controller** điều khiển nhiều máy **Remote Camera** cùng bắt đầu / cùng dừng quay. Mỗi máy quay xong **tự động upload** clip lên server. Vai trò gắn với **tài khoản**, không gắn với thiết bị: đăng nhập tài khoản Controller trên web hay điện thoại đều là Controller, và ngược lại với tài khoản Remote.

- Tài khoản Controller (seed sẵn, duy nhất): **`admin` / `admin`**
- Mọi tài khoản tạo qua màn Đăng ký đều là Remote.

## Cấu trúc monorepo (npm workspaces + Turborepo)

```
apps/
  server/   Express 5 + Prisma 6 + SQLite (28 API + socket.io + ffmpeg)
  web/      React 19 + Vite — Controller và Remote trên trình duyệt
  mobile/   Expo SDK 54 (React Native) — Controller và Remote trên Android/iOS
packages/
  shared/   Dùng chung: Zod schema, mã response, ApiClient, RemoteAgent (đồng bộ lệnh),
            UploadManager (upload theo mảnh), hook TanStack Query cho Controller
```

## Cây thư mục

Không liệt kê các thư mục sinh tự động: `node_modules/`, `dist/`, `.turbo/`, `.expo/`, `apps/server/storage/` (video và mảnh upload), `apps/server/certs/` (chứng chỉ HTTPS), `apps/server/prisma/dev.db` (CSDL SQLite), `apps/mobile/android|ios/` (sinh khi build app).

```
PRJ III/
├── doc.txt                       # Tài liệu đặc tả đề tài (15 chức năng, 28 API, bảng mã response)
├── README.md                     # Tài liệu này
├── package.json                  # Gốc monorepo: khai báo npm workspaces, script dev/build/start/setup, allowScripts
├── package-lock.json             # Khóa phiên bản thư viện cho cả monorepo
├── turbo.json                    # Cấu hình Turborepo: thứ tự và cache các tác vụ build/typecheck/dev
├── tsconfig.base.json            # Cấu hình TypeScript dùng chung, các package kế thừa
├── .gitignore                    # Bỏ qua node_modules, CSDL, video, chứng chỉ, thư mục native sinh ra
├── .agent/launch.json           # Cấu hình mở web dev server 
│
├── packages/
│   └── shared/                   # ── Mã dùng chung cho server, web và mobile ──
│       ├── package.json          # Gói @multicam/shared (xuất mã TypeScript nguồn, có subpath ./react)
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts          # Điểm xuất chung của package
│           ├── codes.ts          # Bảng mã response (1000…4002), message chuẩn và thông báo tiếng Việt cho người dùng
│           ├── constants.ts      # Hằng số: giới hạn 1 GB, mảnh 5 MB, TTL lệnh 30 giây, ngưỡng 500 MB, kiểu thiết bị, vai trò
│           ├── schemas.ts        # Zod schema của mọi request (server validate, client kiểm tra form) + fieldErrors()
│           ├── types.ts          # Kiểu dữ liệu response của 28 API, bám đúng JSON mẫu trong đặc tả
│           ├── api.ts            # ApiClient: hàm gọi từng API, tự refresh token đúng một lần khi gặp 9998, ApiError
│           ├── realtime.ts       # Kết nối socket.io: nhận lệnh đẩy (<1 giây) và sự kiện phòng thay đổi
│           ├── utils.ts          # uuid, đặt/đọc tên file clip theo mẫu, định dạng dung lượng/thời gian, KeyValueStore
│           ├── remote/
│           │   └── RemoteAgent.ts    # "Bộ não" máy Remote: vòng sync_device theo next_sync_in, hàng đợi lệnh,
│           │                         # chống trùng command_id, bỏ lệnh cũ >30 giây, tính lệch đồng hồ, tạm dừng khi vào nền
│           ├── upload/
│           │   └── UploadManager.ts  # Tự động upload: băm SHA-256 → init_upload → gửi mảnh (thử lại 3 lần)
│           │                         # → complete_upload; tiếp tục từ missing_chunks khi mất mạng
│           └── react/
│               ├── index.ts
│               └── hooks.ts      # Hook React: useRoomController (get_room_members + sync_room bằng TanStack Query),
│                                 # useVideoLibrary (phân trang index/count + cache offline), groupBySession,
│                                 # useDownloadQueue ("Đang tải clip 2/5"), useStore, useNow
│
├── apps/
│   ├── server/                   # ── Backend: Express + Prisma + SQLite, chạy trên máy Controller ──
│   │   ├── package.json          # Script dev/start, db:setup (tạo CSDL + seed), cert, test:e2e, sim
│   │   ├── tsconfig.json
│   │   ├── .env                  # Cấu hình: DATABASE_URL, cổng HTTP/HTTPS, JWT_SECRET, thư mục lưu trữ
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # Lược đồ CSDL quan hệ: User, VerifyCode, Device, AuthSession, Room, RoomMember,
│   │   │   │                     # RecordingSession, Command (hàng đợi lệnh), ClientCommand (chống trùng),
│   │   │   │                     # UploadSession, UploadChunk, Video, DownloadTicket
│   │   │   └── seed.ts           # Tạo tài khoản Controller duy nhất: admin / admin
│   │   ├── scripts/
│   │   │   ├── e2e.ts            # Kiểm thử đầu-cuối cả 28 API (79 kiểm tra), sinh video thật bằng ffmpeg
│   │   │   ├── sim-remote.ts     # Giả lập N máy Remote vào phòng: nhận lệnh, "quay" bằng ffmpeg, tự upload
│   │   │   └── gen-cert.ts       # Sinh chứng chỉ HTTPS tự ký kèm IP LAN (để web Remote mở được camera)
│   │   └── src/
│   │       ├── index.ts          # Khởi động server HTTP (3000) + HTTPS (3443), gắn socket.io, chạy job định kỳ
│   │       ├── app.ts            # Tạo Express app, gắn router, phục vụ bản web đã build, trả 9997 khi sai method
│   │       ├── env.ts            # Đọc biến môi trường, thời hạn token/mã mời/phiên upload, đường dẫn thư mục
│   │       ├── db.ts             # Prisma client, bật SQLite WAL và busy_timeout
│   │       ├── types.d.ts        # Khai báo kiểu cho ffprobe-static
│   │       ├── lib/
│   │       │   ├── http.ts       # Gửi response {code, message, data}, AppError, đổi lỗi Zod thành 1002/1003/1004
│   │       │   ├── security.ts   # Băm mật khẩu scrypt, ký/kiểm JWT (claim acc = vai trò), URL có chữ ký + thời hạn
│   │       │   └── ids.ts        # Sinh id (u_, dv_, rm_, mb_, vd_…), mã mời 6 ký tự, mã phiên, mã xác thực 6 số
│   │       ├── middleware/
│   │       │   └── auth.ts       # Xác thực Bearer token, kiểm phiên chưa bị thu hồi, requireController (1009)
│   │       ├── routes/
│   │       │   ├── auth.ts       # Nhóm A (API 1–9): đăng ký, mã xác thực, đăng nhập, refresh, quên/đổi mật khẩu,
│   │       │   │                 # đăng xuất, xóa tài khoản
│   │       │   ├── rooms.ts      # Nhóm B + C (API 10–19): phòng, mã mời, loại/rời/đóng phòng, sync_device,
│   │       │   │                 # sync_room, start/stop quay; thêm API mở rộng lật camera
│   │       │   └── videos.ts     # Nhóm D + E (API 20–28): upload theo mảnh, ghép file + kiểm SHA-256, thư viện,
│   │       │                     # link tải (mỗi lần 1 clip), xóa 1/nhiều clip; route /files phát video có chữ ký
│   │       └── services/
│   │           ├── rooms.ts      # Tăng revision phòng, xếp lệnh vào hàng đợi + đẩy socket, rời/đóng phòng,
│   │           │                 # job đóng hẳn phòng "closing" khi các máy upload xong
│   │           ├── tokens.ts     # Đăng ký thiết bị khi login, cấp access/refresh token theo từng thiết bị
│   │           ├── realtime.ts   # socket.io server: xác thực socket, đẩy lệnh tới máy, báo Controller phòng thay đổi
│   │           └── media.ts      # Gọi ffprobe (thời lượng, codec, độ phân giải) và ffmpeg (sinh thumbnail .jpg)
│   │
│   ├── web/                      # ── Bản web (React + Vite): làm được cả Controller lẫn Remote ──
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts        # Dev server cổng 5173, proxy API và socket.io sang server 3000
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx          # Gắn React Query, Router, SessionProvider
│   │       ├── App.tsx           # Định tuyến theo vai trò: Controller (/room, /library), Remote (/camera, /my-library)
│   │       ├── styles.css        # Giao diện (tối), responsive cho điện thoại
│   │       ├── lib/
│   │       │   ├── platform.ts   # ApiClient của web, lưu token/phiên/UUID thiết bị trong localStorage
│   │       │   ├── session.tsx   # Context đăng nhập/đăng xuất; tạo "máy Remote" khi đăng nhập tài khoản Remote
│   │       │   ├── webRecorder.ts    # Quay bằng getUserMedia + MediaRecorder (MP4 H.264/AAC fragmented), lật camera,
│   │       │   │                     # chụp thumbnail
│   │       │   ├── clipStore.ts      # "Thư mục clip" trên IndexedDB: lưu từng khối video + cờ đã upload
│   │       │   └── remoteRuntime.ts  # Ghép RemoteAgent + UploadManager + recorder + socket; băm bằng hash-wasm;
│   │       │                         # đọc pin, dung lượng trống; khôi phục clip dở khi tab bị đóng
│   │       ├── components/
│   │       │   ├── ui.tsx        # Field, Banner, Modal, ProgressBar, hộp xác nhận, đếm ngược
│   │       │   └── UploadMiniCard.tsx  # Thẻ tiến trình upload thu nhỏ
│   │       └── pages/
│   │           ├── AuthPages.tsx       # Đăng nhập, Đăng ký, Nhập mã xác thực (đếm ngược 120 giây), Quên mật khẩu
│   │           ├── RoomPage.tsx        # [Controller] Màn Điều khiển: mã mời + QR, danh sách máy (pin, dung lượng,
│   │           │                       # chấm đỏ, bộ đếm, upload %), Quay/Dừng, lật camera, loại máy, đóng phòng
│   │           ├── LibraryPage.tsx     # [Controller] Thư viện gom theo phiên, cuộn tải thêm, chọn nhiều để xóa,
│   │           │                       # hàng đợi tải về; trình phát video dùng chung
│   │           ├── CameraPage.tsx      # [Remote] Khung quay, banner đỏ + khóa nút quay khi ở trong phòng,
│   │           │                       # vào phòng bằng mã mời (bắt buộc đồng ý), cảnh báo dưới 500 MB
│   │           ├── RemoteLibraryPage.tsx  # [Remote] Clip trên máy + clip đã upload; chỉ xem, không tải, không xóa
│   │           └── SettingsPage.tsx    # Đổi mật khẩu, đăng xuất, xóa tài khoản 2 bước (ẩn với Controller)
│   │
│   └── mobile/                   # ── App Android/iOS (Expo SDK 54, cần dev build): Controller lẫn Remote ──
│       ├── package.json          # Script start/android/ios/typecheck
│       ├── app.json              # Cấu hình Expo: quyền camera/micro, plugin vision-camera, cho phép HTTP trong LAN,
│       │                         # chế độ chạy nền, tác vụ nền
│       ├── tsconfig.json
│       ├── index.ts              # Điểm vào, đăng ký tác vụ nền trước khi chạy App
│       └── src/
│           ├── App.tsx           # Điều hướng: stack đăng nhập, tab theo vai trò Controller/Remote
│           ├── hooks.ts          # useCountdown, useAppState, thông tin thiết bị gửi khi đăng nhập
│           ├── navigation/
│           │   └── types.ts      # Kiểu tham số các màn hình
│           ├── services/
│           │   ├── storage.ts    # Token trong SecureStore (Keychain/Keystore), AsyncStorage, địa chỉ server, UUID máy
│           │   ├── api.ts        # ApiClient của app, chuyển về màn Đăng nhập khi phiên hết hạn
│           │   ├── session.ts    # Lưu trạng thái đăng nhập (người dùng, vai trò, thiết bị)
│           │   ├── clips.ts      # Thư mục clip <Documents>/clips (.mp4/.jpg/.json/.uploaded), băm SHA-256 native,
│           │   │                 # gửi từng mảnh qua phiên upload nền, dung lượng trống
│           │   ├── recorder.ts   # Cầu nối RemoteAgent ↔ vision-camera: bắt đầu/dừng quay, lưu clip, lật camera
│           │   ├── remote.ts     # RemoteAgent của app (pin qua expo-battery, dung lượng, trạng thái upload)
│           │   ├── upload.ts     # UploadManager dùng chung toàn app (không gắn với màn hình nào)
│           │   ├── background.ts # Tác vụ nền expo-background-task (WorkManager / BGTaskScheduler) để tiếp tục upload
│           │   ├── runtime.ts    # Vòng đời sau đăng nhập: socket, tạm dừng/tiếp tục khi app vào nền,
│           │   │                 # rời phòng, đăng xuất, xóa tài khoản
│           │   └── downloads.ts  # [Controller] Tải clip về thư mục riêng của app, từng clip một, kiểm checksum
│           ├── ui/
│           │   ├── theme.ts      # Màu, khoảng cách, bo góc
│           │   ├── components.tsx # Screen, Button, Field, Checkbox, Card, Banner, ProgressBar…
│           │   └── VideoRow.tsx  # Một dòng clip trong thư viện (thumbnail, thời lượng, dung lượng)
│           └── screens/
│               ├── auth/         # LoginScreen (kèm ô địa chỉ server), SignupScreen, VerifyScreen, ForgotPasswordScreen
│               ├── controller/
│               │   ├── RoomScreen.tsx              # Màn Điều khiển (như bản web)
│               │   └── ControllerLibraryScreen.tsx # Thư viện, chọn nhiều để xóa, hàng đợi tải về
│               ├── remote/
│               │   ├── CameraScreen.tsx        # Khung quay vision-camera, quét QR mã mời, banner đỏ, cảnh báo 500 MB
│               │   ├── RemoteLibraryScreen.tsx # Clip trên máy + trạng thái upload; chỉ xem
│               │   └── DeleteAccountScreen.tsx # Xóa tài khoản: nhập mật khẩu + xác nhận 2 lần
│               └── common/
│                   ├── SettingsScreen.tsx       # Cài đặt chung, đăng xuất
│                   ├── ChangePasswordScreen.tsx # Đổi mật khẩu
│                   └── PlayerScreen.tsx         # Phát video trong ứng dụng (expo-video)
```

## Tech stack

| Hạng mục | Lựa chọn |
|---|---|
| CSDL | SQLite (chạy local, bật WAL) + Prisma 6 |
| Server | Express 5, socket.io (đẩy lệnh < 1 giây), JWT + refresh token xoay vòng, mật khẩu băm scrypt |
| Ghép mảnh, thumbnail | Server nối các mảnh và băm SHA-256 toàn file; `ffmpeg-static` sinh thumbnail, `ffprobe-static` đọc thời lượng / codec / độ phân giải |
| Validation dùng chung | Zod trong `packages/shared` (server validate request, client validate form) |
| Đồng bộ 3–5 giây | Controller: TanStack Query `refetchInterval` theo `next_sync_in`. Remote: `RemoteAgent` (POST `sync_device` có side-effect nên không dùng `useQuery`) |
| Web | React 19, Vite 7, React Router 7, MediaRecorder (MP4 H.264/AAC, fragmented), IndexedDB, `hash-wasm` |
| Mobile | Expo SDK 54, react-native-vision-camera 4, `@dr.pogodin/react-native-fs` (băm SHA-256 native), `expo-file-system` (upload phiên nền), `expo-background-task` (WorkManager / BGTaskScheduler), `expo-secure-store` (Keychain / Keystore) |

Một số điểm đổi so với stack dự kiến ban đầu:

- **`react-native-background-actions` → `expo-background-task` + upload qua phiên nền của `expo-file-system`.** Trên iOS, background-actions chỉ giữ JS sống khoảng 30 giây nên không upload nổi 1 GB. `expo-background-task` dùng đúng WorkManager / BGTaskScheduler như đặc tả yêu cầu. Upload chạy trong một manager ở cấp module, không gắn với màn hình nào, nên chuyển màn hình không làm dừng upload.
- **`react-native-fs` → `@dr.pogodin/react-native-fs`.** Đây là bản fork còn được bảo trì và hỗ trợ New Architecture, API `hash(path, 'sha256')` giữ nguyên.
- **Web không dùng được thư viện RN**, nên có bản riêng: băm bằng `hash-wasm`, lưu clip vào IndexedDB, và cờ `uploaded` thay cho file rỗng `.uploaded`.

## Chạy dự án

Yêu cầu: Node 20 trở lên (đã thử với Node 24), npm 10 trở lên.

```bash
npm install
```

Nếu npm 11 báo chặn install script, duyệt các gói cần thiết (phần duyệt đã lưu sẵn trong `package.json` → `allowScripts`):

```bash
npm install-scripts approve @prisma/client prisma @prisma/engines ffmpeg-static esbuild
```

Tạo CSDL, seed tài khoản admin và sinh chứng chỉ HTTPS cho LAN:

```bash
npm run setup
```

Sau khi kéo code mới có đổi `prisma/schema.prisma` (ví dụ thêm cột), cập nhật CSDL hiện có mà không mất dữ liệu:

```bash
npm exec -w @multicam/server -- prisma db push
```

Chế độ phát triển, chạy server (cổng 3000 / 3443) và web Vite (cổng 5173):

```bash
npm run dev
```

Chế độ chạy thật: build web, sau đó server phục vụ cả API lẫn web trên cùng một cổng:

```bash
npm start
```

Khi khởi động, server in ra các địa chỉ LAN, ví dụ:

```
HTTP : http://localhost:3000  http://192.168.1.2:3000
HTTPS: https://localhost:3443  https://192.168.1.2:3443
```

- **Controller** (máy chạy server) mở `http://localhost:3000`.
- **Remote trên trình duyệt** (điện thoại hoặc laptop khác cùng Wi-Fi) mở `https://<IP>:3443` và chấp nhận cảnh báo chứng chỉ tự ký. Trình duyệt **chỉ cho mở camera trên HTTPS** (hoặc localhost), nên Remote qua LAN bắt buộc dùng cổng 3443.
- **App di động** nhập `http://<IP>:3000` ở màn Đăng nhập. App dùng HTTP thường; cleartext đã được bật trong cấu hình.

### App di động (cần dev build, không chạy trên Expo Go)

```bash
cd apps/mobile
npx expo run:android
```

Thay `run:android` bằng `run:ios` trên macOS, hoặc build bằng EAS. Sau lần build đầu, chỉ cần chạy Metro:

```bash
npm run dev:mobile
```

## Kiểm thử

Kiểm thử đầu-cuối cả 28 API (79 kiểm tra) trên server đang chạy:

```bash
npm run test:e2e -w @multicam/server
```

Giả lập N máy Remote vào phòng để demo màn Điều khiển mà không cần điện thoại. Các máy giả lập nhận lệnh qua socket, quay giả bằng ffmpeg và tự upload thật:

```bash
npm run sim -w @multicam/server -- <MÃ_MỜI> 3
```

Typecheck toàn bộ monorepo:

```bash
npm run typecheck
```

## Ánh xạ yêu cầu → mã nguồn

| Yêu cầu | Vị trí |
|---|---|
| 28 API, mã response | `apps/server/src/routes/*.ts`, `packages/shared/src/codes.ts` |
| Chống trùng lệnh `client_command_id` (1010) | `routes/rooms.ts` → `dedupe()` |
| Hàng đợi lệnh, bỏ lệnh trùng hoặc cũ hơn 30 giây, lệch đồng hồ | `packages/shared/src/remote/RemoteAgent.ts` |
| Upload theo mảnh 5 MB, thử lại 3 lần, tiếp tục từ `missing_chunks` | `packages/shared/src/upload/UploadManager.ts` |
| Tên file `<recorded_at>__<camera_name>__<session_id>__<local_video_uid>.mp4` + `.jpg` | `packages/shared/src/utils.ts` → `buildClipBaseName` |
| Cảnh báo dung lượng < 500 MB, banner đỏ, khóa nút quay | `apps/web/src/pages/CameraPage.tsx`, màn Camera của mobile |
| Thư viện gom theo phiên, phân trang, cache khi mất mạng, hàng đợi tải "clip 2/5" | `packages/shared/src/react/hooks.ts`, `apps/web/src/pages/LibraryPage.tsx` |
| Xóa một clip → `delete_video`, từ hai clip → `delete_videos_bulk` | `LibraryPage.tsx` → `removeSelected` |
| Xác nhận hai lớp khi xóa tài khoản, ẩn với Controller | `apps/web/src/pages/SettingsPage.tsx` |
| Socket đẩy lệnh | `apps/server/src/services/realtime.ts`, `packages/shared/src/realtime.ts` |

## Ghi chú về đặc tả

- **Lật camera:** tài liệu mâu thuẫn. Danh sách 15 chức năng ghi "Controller điều khiển được việc này", còn phần chức năng bên lề ghi "Controller không điều khiển được". Bản này làm cả hai: máy Remote luôn tự lật được, và có thêm API mở rộng `POST /rooms/{room_id}/camera` (ngoài 28 API) để Controller ra lệnh lật.
- **Kiểu dữ liệu response:** giữ nguyên như ví dụ JSON trong tài liệu, kể cả các chỗ trả số dạng chuỗi (`"next_sync_in": "3"`, `"battery_level": "87"`).
- **Mã xác thực:** đặc tả cho phép trả mã trong response. Server còn in mã ra log để mô phỏng việc gửi email/SMS.
- **Lỗi không có mã riêng:** sai mật khẩu trả `1004` kèm `data.field = "password"`; tài khoản bị khóa trả `1009`; start khi không có máy nào online trả `9994`.
- **MP4 fragmented:** web ghi fMP4 qua `MediaRecorder.start(timeslice)`. `vision-camera` trên mobile ghi MP4 thường; server vẫn chấp nhận và xử lý bình thường.
- **Remote trên web:** khi quay phải giữ tab mở và màn hình sáng, vì trình duyệt di động dừng camera khi chuyển tab. Không lật được camera trong lúc đang quay. Mức pin chỉ đọc được trên Chromium.

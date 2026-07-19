#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: build-postgresql-runtime-linux.sh SOURCE_ARCHIVE OUTPUT_DIRECTORY BUILD_ROOT" >&2
  exit 2
fi

SOURCE_ARCHIVE="$(realpath "$1")"
OUTPUT="$(realpath -m "$2")"
BUILD_ROOT="$(realpath -m "$3")"
REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$REPOSITORY/postgresql-runtime.lock.json"
cd "$REPOSITORY"

for tool in curl make gcc perl tar sha256sum patchelf readelf ldd node pnpm; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
[[ -f "$SOURCE_ARCHIVE" ]] || { echo "PostgreSQL source archive does not exist." >&2; exit 1; }
[[ ! -e "$OUTPUT" ]] || { echo "Output already exists: $OUTPUT" >&2; exit 1; }
mkdir -p "$BUILD_ROOT" "$(dirname "$OUTPUT")"

lock_value() {
  node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); let x=v; for(const p of process.argv[2].split(".")) x=x[p]; if(typeof x!=="string") process.exit(2); process.stdout.write(x)' "$LOCK" "$1"
}
verify_sha() {
  local file="$1" expected="$2"
  echo "$expected  $file" | sha256sum --check --status || { echo "SHA-256 mismatch: $file" >&2; exit 1; }
}
safe_extract() {
  local archive="$1" destination="$2" expected_root="$3"
  mkdir "$destination"
  if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "Archive contains an unsafe path: $archive" >&2
    exit 1
  fi
  if tar -tvzf "$archive" | awk 'substr($1,1,1) ~ /^[lh]$/ { found=1 } END { exit !found }'; then
    echo "Archive contains a link: $archive" >&2
    exit 1
  fi
  tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$destination"
  [[ -d "$destination/$expected_root" ]] || { echo "Archive root is invalid: $archive" >&2; exit 1; }
  [[ -z "$(find "$destination" -type l -print -quit)" ]] || { echo "Source archive contains a link." >&2; exit 1; }
}

PG_VERSION="$(lock_value postgresql.version)"
PG_SHA="$(lock_value postgresql.sha256)"
OPENSSL_VERSION="$(lock_value linuxDependencies.openssl.version)"
OPENSSL_URL="$(lock_value linuxDependencies.openssl.url)"
OPENSSL_SHA="$(lock_value linuxDependencies.openssl.sha256)"
ZLIB_VERSION="$(lock_value linuxDependencies.zlib.version)"
ZLIB_URL="$(lock_value linuxDependencies.zlib.url)"
ZLIB_SHA="$(lock_value linuxDependencies.zlib.sha256)"
verify_sha "$SOURCE_ARCHIVE" "$PG_SHA"

WORK="$(mktemp -d "$BUILD_ROOT/postgresql-linux.XXXXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT
DEPS="$WORK/dependencies"
mkdir -p "$DEPS"

curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$WORK/openssl.tar.gz" "$OPENSSL_URL"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$WORK/zlib.tar.gz" "$ZLIB_URL"
verify_sha "$WORK/openssl.tar.gz" "$OPENSSL_SHA"
verify_sha "$WORK/zlib.tar.gz" "$ZLIB_SHA"
safe_extract "$SOURCE_ARCHIVE" "$WORK/postgresql-source" "postgresql-$PG_VERSION"
safe_extract "$WORK/openssl.tar.gz" "$WORK/openssl-source" "openssl-$OPENSSL_VERSION"
safe_extract "$WORK/zlib.tar.gz" "$WORK/zlib-source" "zlib-$ZLIB_VERSION"

JOBS="${SCHEDULE_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
pushd "$WORK/zlib-source/zlib-$ZLIB_VERSION" >/dev/null
CFLAGS="-O2 -fPIC" ./configure --prefix="$DEPS" --libdir="$DEPS/lib"
make -j"$JOBS"
make install
popd >/dev/null

pushd "$WORK/openssl-source/openssl-$OPENSSL_VERSION" >/dev/null
./Configure linux-x86_64 shared --prefix="$DEPS" --openssldir="$DEPS/ssl" --libdir=lib no-docs no-tests
make -j"$JOBS"
make install_sw
popd >/dev/null

PG_SOURCE="$WORK/postgresql-source/postgresql-$PG_VERSION"
PG_BUILD="$WORK/postgresql-build"
mkdir "$PG_BUILD"
pushd "$PG_BUILD" >/dev/null
CPPFLAGS="-I$DEPS/include" \
LDFLAGS="-L$DEPS/lib -Wl,-rpath-link,$DEPS/lib" \
PKG_CONFIG_PATH="$DEPS/lib/pkgconfig" \
"$PG_SOURCE/configure" \
  --prefix="$OUTPUT" \
  --with-ssl=openssl \
  --with-zlib \
  --without-readline \
  --without-icu \
  --without-ldap \
  --without-gssapi \
  --without-pam \
  --without-systemd \
  --without-lz4 \
  --without-zstd \
  --without-libxml \
  --without-libxslt \
  --disable-nls \
  --disable-rpath
make -j"$JOBS"
make install
make -C "$PG_SOURCE/contrib/pgcrypto" USE_PGXS=1 PG_CONFIG="$OUTPUT/bin/pg_config" -j"$JOBS" install
popd >/dev/null

rm -rf -- "$OUTPUT/include" "$OUTPUT/lib/pkgconfig" "$OUTPUT/lib/pgxs" "$OUTPUT/share/doc" "$OUTPUT/share/man"
find "$OUTPUT/lib" -type f \( -name '*.a' -o -name '*.la' \) -delete
for library in libssl.so.3 libcrypto.so.3 libz.so.1; do
  source_path="$(find "$DEPS/lib" -maxdepth 1 -name "$library" -print -quit)"
  [[ -n "$source_path" ]] || { echo "Dependency library missing: $library" >&2; exit 1; }
  cp -L -- "$source_path" "$OUTPUT/lib/$library"
done

mkdir -p "$OUTPUT/LICENSES"
cp "$PG_SOURCE/COPYRIGHT" "$OUTPUT/LICENSES/PostgreSQL.txt"
cp "$WORK/openssl-source/openssl-$OPENSSL_VERSION/LICENSE.txt" "$OUTPUT/LICENSES/OpenSSL.txt"
cp "$WORK/zlib-source/zlib-$ZLIB_VERSION/LICENSE" "$OUTPUT/LICENSES/zlib.txt"

pnpm exec tsx scripts/postgresql-runtime.ts materialize "$OUTPUT" linux-x64
while IFS= read -r -d '' elf; do
  if readelf -h "$elf" >/dev/null 2>&1; then
    case "$elf" in
      "$OUTPUT/bin/"*) patchelf --set-rpath '$ORIGIN/../lib:$ORIGIN/../lib/postgresql' "$elf" ;;
      "$OUTPUT/lib/postgresql/"*) patchelf --set-rpath '$ORIGIN/..:$ORIGIN' "$elf" ;;
      "$OUTPUT/lib/"*) patchelf --set-rpath '$ORIGIN:$ORIGIN/postgresql' "$elf" ;;
    esac
    strip --strip-unneeded "$elf" 2>/dev/null || true
  fi
done < <(find "$OUTPUT/bin" "$OUTPUT/lib" -type f -print0)

allowed_system='^(linux-vdso|ld-linux|libc\.so|libm\.so|libpthread\.so|librt\.so|libdl\.so|libresolv\.so|libgcc_s\.so)'
while IFS= read -r -d '' elf; do
  readelf -h "$elf" >/dev/null 2>&1 || continue
  report="$(ldd "$elf")"
  ! grep -q 'not found' <<<"$report" || { echo "Unresolved dependency for $elf" >&2; echo "$report" >&2; exit 1; }
  while read -r name _ resolved _; do
    [[ "$resolved" == /* ]] || continue
    if [[ "$resolved" != "$OUTPUT"/* && ! "$name" =~ $allowed_system ]]; then
      echo "Unbundled dependency $name => $resolved for $elf" >&2
      exit 1
    fi
  done <<<"$report"
  maximum="$(readelf --version-info "$elf" 2>/dev/null | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p' | sort -V | tail -1)"
  if [[ -n "$maximum" && "$(printf '%s\n' 2.35 "$maximum" | sort -V | tail -1)" != "2.35" ]]; then
    echo "$elf requires GLIBC_$maximum, newer than the Ubuntu 22.04 floor." >&2
    exit 1
  fi
done < <(find "$OUTPUT/bin" "$OUTPUT/lib" -type f -print0)

pnpm exec tsx scripts/postgresql-runtime.ts seal "$OUTPUT" linux-x64 "$LOCK"
pnpm exec tsx scripts/postgresql-runtime.ts verify "$OUTPUT" linux-x64
pnpm exec tsx scripts/smoke-postgresql-runtime.ts "$OUTPUT"

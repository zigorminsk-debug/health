#!/usr/bin/env bash
# ============================================================
# APK builder for "ZI Medical tests"
# Developer: Zakharevich Igor, +375293371413, csl.by
#
# Все пути вычисляются относительно корня репозитория, поэтому скрипт
# работает и локально, и в GitHub Actions. JDK/Android SDK берутся из
# окружения (JAVA_HOME / ANDROID_HOME), иначе — из папок репозитория.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------- JDK ----------------
if [ -z "${JAVA_HOME:-}" ]; then
  if command -v javac >/dev/null 2>&1; then
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
  elif [ -x "$ROOT/jdk-17.0.2/bin/javac" ]; then
    JAVA_HOME="$ROOT/jdk-17.0.2"
    chmod +x "$JAVA_HOME"/bin/* 2>/dev/null || true
  else
    echo "ERROR: JDK не найден. Задайте JAVA_HOME или добавьте javac в PATH." >&2
    exit 1
  fi
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

# ---------------- Android SDK ----------------
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$ROOT/android-sdk}}"
export ANDROID_HOME
BT="$ANDROID_HOME/build-tools/30.0.3"

ANDROID_JAR="$ANDROID_HOME/platforms/android-30/android.jar"
AAPT="$BT/aapt"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"

for f in "$AAPT" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
  [ -e "$f" ] || { echo "ERROR: не найден $f — установите SDK: sdkmanager 'build-tools;30.0.3' 'platforms;android-30'" >&2; exit 1; }
  chmod +x "$f" 2>/dev/null || true
done
[ -f "$ANDROID_JAR" ] || { echo "ERROR: нет $ANDROID_JAR" >&2; exit 1; }
command -v zip     >/dev/null 2>&1 || { echo "ERROR: нужна утилита zip"     >&2; exit 1; }
command -v convert >/dev/null 2>&1 || { echo "ERROR: нужен ImageMagick (convert)" >&2; exit 1; }

# ---------------- Версия / пути ----------------
APP_NAME="ZI Medical tests"
APP_ID="by.csl.budzdorov"
VERSION_CODE="${VERSION_CODE:-68}"
VERSION_NAME="${VERSION_NAME:-1.8.50}"

BUILD_DIR="$ROOT/apk-build"
SRC_WEB="$ROOT/bud-zdorov"
OUT_APK="${OUT_APK:-$ROOT/BudZdorov.apk}"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/gen/by/csl/budzdorov" \
         "$BUILD_DIR/obj" \
         "$BUILD_DIR/assets/www" \
         "$BUILD_DIR/res/values" \
         "$BUILD_DIR/res/mipmap-hdpi" \
         "$BUILD_DIR/res/mipmap-mdpi" \
         "$BUILD_DIR/res/mipmap-xhdpi" \
         "$BUILD_DIR/res/mipmap-xxhdpi" \
         "$BUILD_DIR/res/mipmap-xxxhdpi" \
         "$BUILD_DIR/res/xml"

echo "[1/9] Copy web assets... ($SRC_WEB)"
cp -r "$SRC_WEB"/* "$BUILD_DIR/assets/www/"
rm -f "$BUILD_DIR/assets/www/icons/icon.svg"

echo "[2/9] AndroidManifest.xml (versionCode=$VERSION_CODE, versionName=$VERSION_NAME)"
cat > "$BUILD_DIR/AndroidManifest.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="$APP_ID"
    android:versionCode="$VERSION_CODE"
    android:versionName="$VERSION_NAME">
  <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="30"/>
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
  <!-- NB: android.permission.CAMERA НЕ объявляем: съёмка идёт через системный
       интент, а объявленное без runtime-запроса разрешение ломает
       ACTION_IMAGE_CAPTURE на Android 6+ (SecurityException). -->
  <uses-feature android:name="android.hardware.camera" android:required="false"/>
  <application
      android:allowBackup="true"
      android:icon="@mipmap/ic_launcher"
      android:label="$APP_NAME"
      android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar"
      android:usesCleartextTraffic="true"
      android:networkSecurityConfig="@xml/network_security_config"
      android:hardwareAccelerated="true">
    <activity android:name=".MainActivity"
              android:exported="true"
              android:configChanges="orientation|screenSize|keyboardHidden|screenLayout"
              android:launchMode="singleTask"
              android:windowSoftInputMode="adjustResize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
        <category android:name="android.intent.category.DEFAULT"/>
      </intent-filter>
    </activity>
    <provider android:name=".SimpleFileProvider"
              android:authorities="${APP_ID}.fileprovider"
              android:exported="false"
              android:grantUriPermissions="true">
      <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
    </provider>
  </application>
</manifest>
EOF

cat > "$BUILD_DIR/res/xml/network_security_config.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors><certificates src="system"/></trust-anchors>
  </base-config>
</network-security-config>
EOF

cat > "$BUILD_DIR/res/xml/file_paths.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <external-files-path name="pictures" path="Pictures/"/>
  <external-files-path name="root" path="."/>
</paths>
EOF

echo "[3/9] Resources..."
cat > "$BUILD_DIR/res/values/strings.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">$APP_NAME</string>
</resources>
EOF
# Generate mipmaps of different sizes
convert "$SRC_WEB/icons/icon-512.png" -resize 72x72   "$BUILD_DIR/res/mipmap-hdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 48x48   "$BUILD_DIR/res/mipmap-mdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 96x96   "$BUILD_DIR/res/mipmap-xhdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 144x144 "$BUILD_DIR/res/mipmap-xxhdpi/ic_launcher.png"
convert "$SRC_WEB/icons/icon-512.png" -resize 192x192 "$BUILD_DIR/res/mipmap-xxxhdpi/ic_launcher.png"

echo "[4/9] Java source..."
mkdir -p "$BUILD_DIR/src/by/csl/budzdorov"
cp "$ROOT/apk-build-tmp/MainActivity.java"      "$BUILD_DIR/src/by/csl/budzdorov/MainActivity.java"
cp "$ROOT/apk-build-tmp/SimpleFileProvider.java" "$BUILD_DIR/src/by/csl/budzdorov/SimpleFileProvider.java"
cp "$ROOT/NativeStorage.java"                    "$BUILD_DIR/src/by/csl/budzdorov/NativeStorage.java"

echo "[5/9] Compile resources with aapt..."
cd "$BUILD_DIR"
$AAPT package -f -m -J "$BUILD_DIR/gen" -M AndroidManifest.xml -S res -I "$ANDROID_JAR"

echo "[6/9] Compile Java..."
find "$BUILD_DIR/gen" -name "*.java" > "$BUILD_DIR/sources.txt"
find "$BUILD_DIR/src" -name "*.java" >> "$BUILD_DIR/sources.txt"
javac -encoding UTF-8 -source 11 -target 11 -nowarn -classpath "$ANDROID_JAR" -d "$BUILD_DIR/obj" @"$BUILD_DIR/sources.txt"

echo "[7/9] Convert to dex (d8)..."
$D8 --min-api 21 --output "$BUILD_DIR" $(find "$BUILD_DIR/obj" -name "*.class") --lib "$ANDROID_JAR"

echo "[8/9] Package APK..."
$AAPT package -f -M AndroidManifest.xml -S res -A assets -I "$ANDROID_JAR" -F "$BUILD_DIR/app.unsigned.apk"
cp "$BUILD_DIR/app.unsigned.apk" "$BUILD_DIR/app.withdex.apk"
cd "$BUILD_DIR" && zip -j app.withdex.apk classes.dex >/dev/null

echo "[9/9] Align + sign..."
$ZIPALIGN -f 4 "$BUILD_DIR/app.withdex.apk" "$BUILD_DIR/app.aligned.apk"
# ---------- Persistent release keystore ----------
# Один ключ подписи: все новые APK ставятся поверх старых без uninstall.
# В CI ключ можно передать через секрет BUDZDOROV_KEYSTORE_B64 (base64 файла)
# и пароль BUDZDOROV_KS_PASS; локально используется budzdorov.jks из репозитория.
KEYSTORE="${BUDZDOROV_KEYSTORE:-$ROOT/budzdorov.jks}"
KS_PASS="${BUDZDOROV_KS_PASS:-bz_zdorov_2026}"
if [ -n "${BUDZDOROV_KEYSTORE_B64:-}" ]; then
  KEYSTORE="$BUILD_DIR/ci-keystore.jks"
  echo "$BUDZDOROV_KEYSTORE_B64" | base64 -d > "$KEYSTORE"
fi
if [ ! -f "$KEYSTORE" ]; then
  echo "[key] Generating signing key at $KEYSTORE (keep this file!)..."
  keytool -genkeypair -v \
          -keystore "$KEYSTORE" \
          -storepass "$KS_PASS" \
          -alias budzdorov \
          -keypass "$KS_PASS" \
          -keyalg RSA -keysize 2048 -validity 36500 \
          -dname "CN=Zakharevich Igor, OU=csl.by, O=CSL, L=Minsk, ST=Minsk, C=BY" >/dev/null
  echo "[key] Keystore created. DO NOT DELETE $KEYSTORE — without it future updates won't install over the old version."
fi
$APKSIGNER sign \
  --ks "$KEYSTORE" \
  --ks-key-alias budzdorov \
  --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" \
  --out "$OUT_APK" \
  "$BUILD_DIR/app.aligned.apk"
# Verify signature
$APKSIGNER verify --verbose "$OUT_APK" | tail -5

echo ""
echo "✅ APK built: $OUT_APK (v$VERSION_NAME, code $VERSION_CODE)"
ls -lh "$OUT_APK"

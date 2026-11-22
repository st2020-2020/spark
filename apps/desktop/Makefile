.PHONY: frontend build test app-bundle
export MACOSX_DEPLOYMENT_TARGET := 13.0
export CGO_CFLAGS += -mmacosx-version-min=13.0
export CGO_CXXFLAGS += -mmacosx-version-min=13.0
BUILD_DIR ?= build
OUT := $(BUILD_DIR)/Spark.app
frontend:
	cd frontend && npm ci --no-audit --no-fund && npm run build

build: frontend
	mkdir -p "$(BUILD_DIR)"
	CGO_ENABLED=1 go build -ldflags="-extldflags=-mmacosx-version-min=13.0" -tags production -o "$(BUILD_DIR)/Spark" .

test: frontend
	go test -race ./...

app-bundle: build
	mkdir -p $(OUT)/Contents/MacOS $(OUT)/Contents/Resources $(BUILD_DIR)/Spark.iconset
	cp "$(BUILD_DIR)/Spark" $(OUT)/Contents/MacOS/Spark
	cp packaging/Info.plist $(OUT)/Contents/Info.plist
	for size in 16 32 128 256 512; do sips -z $$size $$size ../web/public/icon-512.png --out $(BUILD_DIR)/Spark.iconset/icon_$${size}x$${size}.png >/dev/null; done
	iconutil -c icns $(BUILD_DIR)/Spark.iconset -o $(OUT)/Contents/Resources/Spark.icns
	codesign --force --sign - $(OUT)

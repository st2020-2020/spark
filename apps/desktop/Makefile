.PHONY: frontend build test app-bundle
OUT := build/Spark.app
frontend:
	cd frontend && npm ci --no-audit --no-fund && npm run build

build: frontend
	mkdir -p build
	CGO_ENABLED=1 go build -tags production -o build/Spark .

test: frontend
	go test -race ./...

app-bundle: build
	mkdir -p $(OUT)/Contents/MacOS $(OUT)/Contents/Resources build/Spark.iconset
	cp build/Spark $(OUT)/Contents/MacOS/Spark
	cp packaging/Info.plist $(OUT)/Contents/Info.plist
	for size in 16 32 128 256 512; do sips -z $$size $$size ../web/public/icon-512.png --out build/Spark.iconset/icon_$${size}x$${size}.png >/dev/null; done
	iconutil -c icns build/Spark.iconset -o $(OUT)/Contents/Resources/Spark.icns
	codesign --force --sign - $(OUT)

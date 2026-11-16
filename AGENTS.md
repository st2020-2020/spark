# Spark 开发约定

界面统一使用 MyGo Native UI（`github.com/egoist/mygo/ui`）。窗口和菜单从 `main.go` 初始化。新增视图和交互沿用 `internal/app/` 的组件、主题和状态管理方式。

运行和打包命令见 `README.md`。界面规范见 `DESIGN.md`，交互行为见 `UX-CONTRACT.md`。

修改后运行 `CGO_ENABLED=0 go test ./...`。界面测试使用 MyGo 的 `ui.Tester`，存储测试使用临时 SQLite 数据库。

package main

import (
	"context"
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"spark/internal/app"
	"spark/internal/db"
	"spark/internal/entries"
)

func main() {
	entries.LoadDotEnv()

	conn, err := db.Open("")
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	svc := entries.NewService(conn)
	sparkApp := app.New(ctx, svc)

	mygo.App.WhenReady(func() {
		mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
			{Role: mygo.RoleAppMenu},
			{Role: mygo.RoleFileMenu},
			{Role: mygo.RoleEditMenu},
			{Role: mygo.RoleWindowMenu},
		}))

		win := mygo.NewWindow(mygo.WindowOptions{
			Title:     "Spark · 随手记，慢慢想",
			Width:     1080,
			Height:    740,
			MinWidth:  720,
			MinHeight: 500,
			StateKey:  "spark-main",
			Content:   ui.View(sparkApp.View),
		})
		sparkApp.SetWindow(win)

		go svc.ResumePending(ctx)
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

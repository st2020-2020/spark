# syntax=docker/dockerfile:1
FROM golang:1.27.3-alpine AS build
WORKDIR /src
ARG GOPROXY
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/spark-api ./cmd/api && \
    CGO_ENABLED=0 go build -trimpath -o /out/spark ./cmd/spark

FROM scratch AS runtime
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/spark-api /spark-api
COPY --from=build /out/spark /spark
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/spark-api"]

FROM build AS test
ENV CGO_ENABLED=0
CMD ["go", "test", "./...", "-count=1"]

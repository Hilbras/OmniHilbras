docker stop omnihilbras
docker rm omnihilbras
docker build -t omnihilbras .
docker run -d --name omnihilbras -p 20128:20128 --env-file .env -v omnihilbras-data:/app/data omnihilbras
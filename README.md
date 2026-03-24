# Translation Microservice

This Dockerized microservice provides general-purpose tools for translations management via HTTP API endpoints on port 5002.

## Docker image configuration

The image exposes all the API endpoints on port `5002`.
A volume must be mounted to store the available translations.

**Example `docker-compose.yml`**

```yaml
services:
    translation-service:
        image: edertone/translation-service:X.X.X
        ports: # Remove if you don't want external access to this container
            - '5002:5002'
        volumes:
            # Store all the translations you want to use
            # The folders structure must be: TODO
            - ./my/local/translations-folder:/app/translations-folder
```

## API Documentation

- [TODO Endpoints](./docs/todo.md)

## Development documentation

- [Development, testing and deployment documentation](./docs/develop-test-publish.md)

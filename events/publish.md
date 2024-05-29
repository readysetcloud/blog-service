# Event schemas and examples

## Publish Blog

### Example

```json
{
  "key": "asdfas734523dfg98#/a-personal-note",
  "fileName": "a-personal-note",
  "url": "/blog/allen.helton/a-personal-note",
  "publisher": "dev",
  "auth": {
    "location": "header",
    "key": "api-key"
  },
  "request": {
    "method": "POST",
    "headers": {
      "accept": "application/vnd.forem.api-v1+json"
    },
    "baseUrl": "https://dev.to/api/articles",
  },
  "output": {
    "url": {
      "format": "path",
      "path": "$.result.Payload.id",
    },
    "id": {
      "format": "composed",
      "path": "$.result.Payload.id",
      "template": "{}"
    }
  }
}
```

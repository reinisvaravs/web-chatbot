import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
dotenv.config();

const s3Client = new S3Client({
  endpoint: process.env.R2CLIENT_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.R2CLIENT_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2CLIENT_SECRET_ACCESS_KEY,
  },
});

export default s3Client;

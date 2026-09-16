import 'dotenv/config';
import app from './app';

const PORT = process.env.PORT ? Number(process.env.PORT) : 5001;

app.listen(PORT, () => {
  console.log(`Local server running on port ${PORT}`);
});

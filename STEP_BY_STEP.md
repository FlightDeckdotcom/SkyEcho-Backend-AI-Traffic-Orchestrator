# Step by step

1. Replace the files in your `SkyEcho-Backend-AI-Traffic-Orchestrator` GitHub repo with this package.
2. In Render, keep the backend as a Web Service.
3. Set build command to `corepack enable && yarn install`.
4. Set start command to `npm start`.
5. Add or confirm `NAVDATA_BASE_URL=https://raw.githubusercontent.com/FlightDeckdotcom/SKYECHOCABIN-Discord-Bot/main/data`.
6. Deploy.
7. Open `/data/status` and verify row counts for the GitHub CSV files.
8. In the SkyEcho frontend v5.1 panel, click `Data`, then `Start Traffic`.

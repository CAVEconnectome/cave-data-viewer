from cave_data_viewer.api import create_app

if __name__ == "__main__":
    app = create_app()
    import os
    port = int(os.environ.get("CDV_PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=True)

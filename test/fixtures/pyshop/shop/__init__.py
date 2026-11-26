from flask import Flask
from shop.config import settings


def create_app():
    app = Flask(__name__)
    app.config.update(settings)
    return app

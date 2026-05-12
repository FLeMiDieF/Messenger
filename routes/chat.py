from flask import Blueprint, render_template
from flask_login import login_required

chat = Blueprint("chat", __name__)


@chat.route("/")
@login_required
def index():
    return render_template("chat/index.html")

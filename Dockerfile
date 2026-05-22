FROM pandoc/latex:3.9-ubuntu

ARG NODE_VERSION=26

SHELL ["/bin/bash", "-c"]

RUN apt-get update
RUN apt-get install -y curl build-essential

RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
ENV NVM_DIR=/root/.nvm
RUN source $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default \
    && npm i -g mathjax-node

RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo install pandoc-katex

COPY . /doc
WORKDIR /doc

ENTRYPOINT [ "./run.sh" ]